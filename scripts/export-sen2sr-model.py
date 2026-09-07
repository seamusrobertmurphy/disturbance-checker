#!/usr/bin/env python3
"""Convert ESA OpenSR's SEN2SRLite weights to ONNX and check the conversion.

Writes vendor/sen2srlite-rgbn-x4.onnx, which src/raster/sen2sr.ts loads in the
browser, and which is committed for the same reason the cloud models are: a
deployment that fetched its own weights at build time could quietly change what
the operator sees between two deploys of the same tagged plugin.

    python3 scripts/export-sen2sr-model.py

Needs sen2sr, mlstac, torch, onnx and onnxruntime, none of them runtime
dependencies of the plugin. Install with:

    python3 -m pip install --user sen2sr mlstac

Provenance. Code MIT from ESAOpenSR/SEN2SR, weights from the Hugging Face repo
tacofoundation/sen2sr, variants SEN2SRLite/NonReference_RGBN_x4 and
SEN2SRLite/Reference_RSWIR_x2.

Two operations in the model as ESA ships it have no ONNX equivalent, a pair of
Fourier transforms and an antialiased bicubic enlargement, so both are rewritten
here as fixed convolutions that compute the same thing. That rewrite is the
reason the parity check below is not a formality: it is checking arithmetic this
script invented against arithmetic ESA wrote.
"""

import json
import sys
import time
from pathlib import Path

import mlstac
import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
CACHE = ROOT / ".cache" / "sen2sr"
MODELS = CACHE / "model"

HUB = "https://huggingface.co/tacofoundation/sen2sr/resolve/main/SEN2SRLite"

# The window both models were trained on.
PATCH = 128

# The blend kernel is a Gaussian, so it is compact. 31 pixels holds all of its
# energy to the precision float32 carries; 15 holds 99.999 percent.
BLEND = 31

# The tiler discards a border in any case, and the padding rule at the edge
# differs from the circular wrap the Fourier version implies, so parity is
# measured inside this margin.
MARGIN = 32

# Float32 rounding on a graph this size. Anything larger means the rewrite of
# the constraint changed the model rather than restating it.
MAX_DIFFERENCE = 1e-5

# Band order the 20 metre model expects, and where each resolution sits in it.
BANDS_20M = [3, 4, 5, 7, 8, 9]
BANDS_10M = [0, 1, 2, 6]


def spatial_kernel(mask: torch.Tensor, width: int) -> torch.Tensor:
    """The stored low-pass mask, written as the convolution it is equivalent to."""
    full = torch.fft.fftshift(torch.fft.ifft2(torch.fft.ifftshift(mask)).real)
    centre = mask.shape[0] // 2
    half = width // 2
    k = full[centre - half : centre + half + 1, centre - half : centre + half + 1]
    return k / k.sum()


def resample_kernel(scale: int, mode: str) -> torch.Tensor:
    """The antialiased enlargement, recovered by reading its impulse response."""
    impulse = torch.zeros(1, 1, 64, 64)
    impulse[0, 0, 32, 32] = 1.0
    response = F.interpolate(
        impulse, scale_factor=scale, mode=mode, antialias=True
    )[0, 0]
    rows, cols = torch.nonzero(response.abs() > 1e-7, as_tuple=True)
    return response[rows.min() : rows.max() + 1, cols.min() : cols.max() + 1].clone()


def depthwise(kernel: torch.Tensor, channels: int) -> torch.Tensor:
    size = kernel.shape[-1]
    return kernel.view(1, 1, size, size).repeat(channels, 1, 1, 1)


class PortableRGBN(torch.nn.Module):
    """Four 10 metre bands to 2.5 metres, constraint included."""

    def __init__(self, cnn, mask):
        super().__init__()
        self.cnn = cnn
        up = resample_kernel(4, "bicubic")
        self.pad = BLEND // 2
        self.crop = (up.shape[-1] - 4) // 2
        self.register_buffer("up_k", depthwise(up, 4))
        self.register_buffer("blend_k", depthwise(spatial_kernel(mask, BLEND), 4))

    def forward(self, x):
        sr = torch.clamp(self.cnn(x), min=0.0)
        up = F.conv_transpose2d(x, self.up_k, stride=4, padding=self.crop, groups=4)
        d = F.pad(up - sr, (self.pad,) * 4, mode="replicate")
        return sr + F.conv2d(d, self.blend_k, groups=4)


class PortableRSWIR(torch.nn.Module):
    """Six 20 metre bands to 10 metres, the four 10 metre bands passed through."""

    def __init__(self, cnn, mask):
        super().__init__()
        self.cnn = cnn
        up = resample_kernel(2, "bilinear")
        self.pad = BLEND // 2
        self.crop = (up.shape[-1] - 2) // 2
        self.register_buffer("up_k", depthwise(up, 6))
        self.register_buffer("blend_k", depthwise(spatial_kernel(mask, BLEND), 6))

    def forward(self, x):
        coarse = x[:, BANDS_20M]
        fine = x[:, BANDS_10M]
        up = F.conv_transpose2d(
            coarse[:, :, ::2, ::2], self.up_k, stride=2, padding=self.crop, groups=6
        )
        sr = torch.clamp(self.cnn(torch.cat([up, fine], dim=1)), min=0.0)
        d = F.pad(up - sr, (self.pad,) * 4, mode="replicate")
        sr = sr + F.conv2d(d, self.blend_k, groups=6)
        return torch.stack(
            [
                fine[:, 0], fine[:, 1], fine[:, 2],
                sr[:, 0], sr[:, 1], sr[:, 2],
                fine[:, 3],
                sr[:, 3], sr[:, 4], sr[:, 5],
            ],
            dim=1,
        )


# Only the model the browser loads is committed to vendor/. The 20 metre to 10
# metre model is built here too, because notes/super-resolution.md quotes its
# timings, but it stays in .cache until something in src/ asks for it.
VARIANTS = [
    ("sen2srlite-rgbn-x4", "NonReference_RGBN_x4", PortableRGBN, "lr", "sr", True),
    ("sen2srlite-rswir-x2", "Reference_RSWIR_x2", PortableRSWIR, "s2", "sharp", False),
]

VENDOR.mkdir(exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
torch.set_grad_enabled(False)

report = {}
failed = False

for name, variant, wrapper, input_name, output_name, ship in VARIANTS:
    folder = MODELS / variant
    if not folder.exists():
        print(f"downloading {variant}")
        mlstac.download(file=f"{HUB}/{variant}/mlm.json", output_dir=str(folder))

    shipped = mlstac.load(str(folder))
    model = shipped.compiled_model(device="cpu")

    # The reference pair the package ships. The 20 metre model returns only the
    # low-resolution stack, the 4x model returns a true high-resolution one too.
    example = shipped.example_data()
    sample = (example[0] if isinstance(example, tuple) else example)[:1].float()

    expected = model(sample)

    portable = wrapper(model.sr_model, model.hard_constraint.low_pass_mask).eval()
    torch_out = portable(sample)

    path = (VENDOR if ship else CACHE) / f"{name}.onnx"
    torch.onnx.export(
        portable,
        (sample,),
        str(path),
        input_names=[input_name],
        output_names=[output_name],
        opset_version=20,
        # The dynamo exporter segfaults torch 2.13 on macOS arm64, dying inside
        # direct_copy_kernel during decomposition. The legacy tracer is fine.
        dynamo=False,
    )
    graph = onnx.load(str(path), load_external_data=True)
    for stale in path.parent.glob(f"{path.name}.data"):
        stale.unlink()
    onnx.save(graph, str(path), save_as_external_data=False)

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    actual = session.run(None, {input_name: sample.numpy()})[0]

    def interior(a):
        return a[..., MARGIN:-MARGIN, MARGIN:-MARGIN]

    rewrite = float(np.abs(interior(torch_out.numpy() - expected.numpy())).max())
    export = float(np.abs(interior(actual - expected.numpy())).max())
    repeat = bool(
        np.array_equal(session.run(None, {input_name: sample.numpy()})[0], actual)
    )
    kilobytes = round(path.stat().st_size / 1024)

    timings = []
    for _ in range(15):
        t0 = time.perf_counter()
        session.run(None, {input_name: sample.numpy()})
        timings.append((time.perf_counter() - t0) * 1000)
    median = float(np.median(timings))

    ok = rewrite <= MAX_DIFFERENCE and export <= MAX_DIFFERENCE and repeat
    failed = failed or not ok
    report[name] = {
        "variant": variant,
        "parameters": sum(p.numel() for p in model.sr_model.parameters()),
        "kilobytes": kilobytes,
        "maxRewriteDifference": rewrite,
        "maxExportDifference": export,
        "deterministic": repeat,
        "medianPatchMilliseconds": round(median, 1),
        "matchesShipped": ok,
    }
    print(
        f"{name}: {kilobytes} KB, rewrite {rewrite:.2e}, export {export:.2e}, "
        f"deterministic {repeat}, {median:.0f} ms per {PATCH} by {PATCH} patch"
    )

(VENDOR / "sen2sr-model.json").write_text(json.dumps(report, indent=2) + "\n")

if failed:
    sys.exit(
        "\nThe export does not match the model ESA ships. Nothing downstream "
        "should use these files."
    )
print(f"\nShipped to {VENDOR}, evaluated in {CACHE}")
