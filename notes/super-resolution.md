# Super-resolution

Notes written on 2026-09-06 after installing ESA OpenSR's `opensr-utils`
version 2.0.0 from the local clone at `/Volumes/PortableSSD/Github/opensr-utils`
(upstream `https://github.com/ESAOpenSR/opensr-utils`, commit `5b5a62a`). It lives in
`notes/` rather than `docs/`, because `docs/` is the in-app guide library and
`scripts/smoke-test.mjs` fails the build on any file there that
`src/help/registry.ts` does not register. This is a working note, not a guide.

## What it does

Think of a Sentinel-2 scene as a photograph taken from too far away, printed on
graph paper where each square is 10 metres across. Super-resolution redraws that
photograph on finer graph paper, 2.5 metre squares, and guesses what belongs
inside each new small square by learning what real fine detail usually looks
like. It is a trained guess, not a new measurement.

`opensr-utils` is the machinery around that guess rather than the guess itself.
It cuts a large scene into 128 by 128 pixel patches, hands each patch to a
PyTorch model, and glues the enlarged patches back together. The gluing is the
part worth having. Patches that simply abut leave a visible grid of seams, so
the package overlaps them by a chosen number of pixels and fades one into the
next on a sigmoid curve, and it can also throw away a fixed border from every
patch where models tend to misbehave. It writes a georeferenced GeoTIFF at the
end, keeping the coordinate reference system and dividing the pixel size by the
scale factor.

The model it ships with is LDSR-S2, a latent diffusion model. Diffusion starts
from noise and removes a little of it at a time, so producing one patch means
running the network many times over. The configuration at
`opensr_model/configs/config_10m.yaml` sets `sampling_steps: 100`, so each
128 by 128 patch costs one hundred sequential passes through a U-Net plus a
decode step.

It only handles the four Sentinel-2 bands recorded at 10 metres, which are blue
B02, green B03, red B04 and near-infrared B08. Nothing else.

## Installed here

The package was installed for the MacPorts Python 3.12 at
`/opt/local/bin/python3`, as an editable user install so it reads the code
straight from your clone.

    python3 -m pip install --user -e "/Volumes/PortableSSD/Github/opensr-utils[model,cog]"

Fifteen packages were added and nothing was downgraded. The additions were
`einops`, `omegaconf`, `pytorch-lightning`, `torchmetrics`,
`lightning-utilities`, `xarray`, `scikit-image`, `imageio`, `tifffile`,
`lazy-loader`, `antlr4-python3-runtime`, `morecantile`, `rio-cogeo`,
`opensr-model` 1.1.1 and `opensr-utils` 2.0.0 itself. The `torch` 2.13.0,
`rasterio` 1.5.0 and `numpy` 2.4.6 already on the machine were left alone.

MacPorts carries `py312-omegaconf`, `py312-xarray` and `py312-scikit-image`, and
those would have been the preferred source, but installing them needs a `sudo`
password that a non-interactive session cannot supply, so pip provided all
fifteen. Swapping the three over later is optional and would need the pip copies
removed first to avoid two versions on the path.

The command line entry point landed at
`/Users/seamus/Library/Python/3.12/bin/opensr-run` and is already on your PATH.

Two consequences of the editable install are worth knowing. Imports resolve to
`/Volumes/PortableSSD/Github/opensr-utils/opensr_utils/`, so `git pull` in that
clone changes the installed package immediately, and unmounting the portable SSD
breaks `import opensr_utils` until it is mounted again.

## Verified behaviour

A 384 by 384 pixel four-band GeoTIFF on a 10 metre grid in EPSG:32610 was run
through the interpolation placeholder at a factor of 4. It produced a 1536 by
1536 GeoTIFF at 2.5 metres in the same projection in 17 seconds of wall clock
time, with the sixteen patches stitched and the temporary folder cleaned up.

The first attempt wrote an output of all zeros, and the cause is a trap worth
recording. The input carried float reflectance between 0 and 1.
`opensr_utils/data_utils/writing_utils.py` line 434 casts the blended result to
the output raster's dtype, which was an integer type, so every reflectance value
rounded to zero. Rewriting the same scene as native Sentinel-2 integer counts
between 0 and 10000 produced correct output, band 4 running from 1599 to 7999
with a mean of 4843. Feed it the archive's own integer values and do the
division by 10000 afterwards.

Apple's GPU cannot be used. `opensr_utils/pipeline.py` line 169 raises a
`ValueError` unless the device is exactly `cpu` or `cuda`, and this machine has
no CUDA. PyTorch Lightning prints `GPU available: True (mps), used: False`
during a run, which reads like an oversight but is the package refusing a device
it does not support. Every run on this Mac is a CPU run.

The real model was then loaded and timed on this machine. LDSR-S2 holds 169.0
million parameters, of which the denoising U-Net reports 113.63 million. Loading
it took 113.3 seconds including the download. One 128 by 128 patch took 133.6
seconds on CPU and returned the expected 512 by 512 output.

That single measurement sets the scale of everything else. With a 128 pixel
window and 12 pixels of overlap the stride is 116 pixels, so a full Sentinel-2
tile of 10980 pixels needs 95 patches on a side, or 9,025 in all, which at 133.6
seconds each is about 335 hours, near enough fourteen days. A 500 hectare
project boundary is four patches and about nine minutes. A 5,000 hectare
boundary is thirty-six patches and about eighty minutes. These extrapolate from
one patch with no batching, so they are an upper bound and batching would
improve them somewhat, though not by an order of magnitude on CPU. The useful
conclusion is that project-sized areas are perfectly practical overnight and
whole tiles are not, which is the opposite way round from what the package's
own description suggests, because it was written for multi-GPU machines.

The checkpoint is downloaded into the current working directory, not into a
shared cache. `opensr_model`'s `load_pretrained` builds a path from the bare
filename `opensr-ldsrs2_v1_0_0.ckpt` and fetches it from Hugging Face when that
path does not exist, so it lands beside wherever you happened to run the
command, and it is 1.1 GB. Run from a directory with room for it, and either
work from the same directory each time or copy the file across, otherwise every
new folder pays the download again.

## Browser recommendation

The short answer is that this should not go into the browser tool as an analysis
step, and there is a narrow version of it that is worth doing later. Five
findings drive that, and the last one is the one that decides it.

**Band coverage.** The package super-resolves B02, B03, B04 and B08 only. Of the
three indices in `src/analysis/deltas.ts`, NDVI is built from red B04 and
near-infrared B08, so it is fully covered. NDMI is built from B08 and short-wave
infrared B11, and NBR from the narrow near-infrared B8A and short-wave infrared
B12. B11, B12 and B8A are recorded at 20 metres and this package does not touch
them. Super-resolution therefore reaches one of the three findings the SOP
reports and leaves the other two on their native grid.

**Analysis scale.** `ANALYSIS_SCALE` in `src/defaults.ts` is 20 metres, which is
the SOP's scale for the histogram and the hectare counts and is also the native
resolution of B11, B12 and SCL. Super-resolution produces 2.5 metre pixels,
eight times finer than the grid the classification and the area reductions run
on. Pushing 2.5 metre pixels into a 20 metre reduction averages the invented
detail straight back out, so the classified rasters and the class areas would be
unchanged while the run cost far more.

**Cost.** The existing cloud mask in `src/raster/omni.ts` is two U-Nets, one
forward pass each, and the comment there records 263 milliseconds for a 512
pixel block on WebGPU against 6,301 milliseconds on WebAssembly. LDSR-S2 needs
one hundred sequential U-Net passes plus a decode for each 128 pixel patch, and
it writes sixteen times as many output pixels. Measured here, one such patch
took 133.6 seconds on CPU. Even granting WebGPU the same twenty-four fold
speed-up the cloud model saw, a 500 hectare boundary would still be minutes of
solid computation per reporting period, on top of a run that already takes
minutes, in a tab the operator cannot leave.

**Weights.** The two cloud models in `vendor/` total 60 MB. The LDSR-S2
checkpoint measured 1.1 GB, holding 169.0 million parameters. Users would
download roughly nineteen times the current weight budget before the first pixel
appeared, over the same connection that is already fetching imagery.

**Reproducibility.** This is the argument that settles it. Diffusion sampling is
random, and the shipped configuration is not close to deterministic, with
`sampling_eta: 0.95` and `sampling_temperature: 1.0`. Two runs of the same area
with the same parameters would produce different imagery and therefore different
index values. The run manifest in `src/manifest.ts` records every parameter and
every threshold precisely so that a verification result can be reconstructed,
and an evidence layer that changes between runs cannot be reconstructed from a
record of its parameters unless the random seed is pinned and recorded too. For
an ACR verification deliverable that is a serious defect rather than an
inconvenience.

### What to do instead

Treat super-resolved imagery as context for the eye, never as an input to the
numbers. The genuinely useful version is a 2.5 metre true-colour backdrop for
the pre and post windows, so that an operator looking at a High severity patch
can see whether it is a cutblock, a road, a windthrow gap or a shadow. Generate
it offline with the command line tool, convert it to a cloud-optimised GeoTIFF
with the `rio-cogeo` extra that was just installed, host it, and add it as an
ordinary raster layer beside the twelve the panel already paints. The analysis
keeps reading the archive at 10 and 20 metres exactly as it does now, so nothing
in the SOP chain moves.

If in-tab super-resolution is wanted later, the path is already proven in this
repository and it is not the diffusion model. `scripts/export-cloud-model.py`
converts PyTorch weights to ONNX, checks the conversion against the model it
came from before keeping it, and commits the result to `vendor/`.
`src/raster/omni.ts` loads the ONNX runtime from the deployed path rather than
bundling it, asks for WebGPU explicitly and falls back to WebAssembly, and
records which one ran in the manifest. A single-pass super-resolution network,
meaning one forward pass rather than a hundred, would follow that same route,
and it would be deterministic into the bargain. `opensr-utils` accepts any
`torch.nn.Module` with a `forward` method, so such a model could be validated at
full tile scale on the desktop first and then exported for the tab.

## Rendered backdrops

This section answers a narrower question asked on 2026-09-06. If the only goal
were a super-resolved true-colour backdrop for the pre and post windows, with
the indices left alone, what would the app have to do and what would it cost on
a 90,000 acre project.

### Where it fits

The work would go in one place. `src/analysis/run.ts` line 339 splits the area
into blocks of 512 pixels with `blocksFor(grid, BLOCK_SIZE)`, and inside each
block it fetches scenes, masks cloud, and reduces the window to a median. The
super-resolution would run on that median, once per reporting period, in exactly
the position `src/raster/omni.ts` already occupies for the cloud model. The four
bands the model needs are blue B02, green B03, red B04 and near-infrared B08,
and `REQUIRED_ASSETS` in `src/stac/search.ts` already lists all four, so nothing
extra would be fetched.

Nothing else in the run would change. The indices, the deltas, the histogram and
the hectare counts would carry on reading the 20 metre working grid, and the
super-resolved raster would be an extra painted layer beside the twelve already
drawn.

### The display cap

Here the plan runs into the renderer. `buildWarp` in `src/render/paint.ts` line
84 takes `maxDimension = 2048` and line 103 scales any grid larger than that
down to fit, because a bigger image is one the browser will refuse to upload as
a texture. `run.ts` line 341 calls it with the default, so every layer the panel
paints is at most 2048 pixels on its longest side.

Work through 90,000 acres, which is 36,422 hectares, or 364.2 square kilometres,
a square roughly 19,084 metres on a side. On the present 20 metre grid that is
954 pixels, comfortably under the cap, painted one to one, and the operator sees
20 metres per screen pixel. Super-resolved to 2.5 metres the same area is 7,634
pixels, so `buildWarp` scales it by 0.268 and paints 2048, and the operator sees
9.3 metres per screen pixel.

Now the comparison that settles it. Reading the same bands at their native 10
metres, with no model at all, gives 1,908 pixels, still under the cap, painted
one to one, and the operator sees 10.0 metres per screen pixel. So the
super-resolved backdrop delivers 9.3 metres on screen and the free one delivers
10.0 metres. At this size they are the same picture. Every invented pixel is
thrown away by the texture cap before anyone sees it.

### The cost

The patch count follows from the geometry. On the 10 metre grid the area is
1,908 pixels a side, and with a 128 pixel window and 12 pixels of overlap the
stride is 116, so 17 patches a side, 289 per composite, 578 for a pre and a post
window together.

Measured on this machine, one patch took 133.6 seconds in PyTorch on CPU, which
puts 578 patches at 21.5 hours natively. For the browser there is a usable
anchor. The two cloud models this repository already ships ran a 512 block in
423 milliseconds under ONNX Runtime on CPU here, against the 263 milliseconds on
WebGPU and 6,301 milliseconds on WebAssembly recorded in `src/raster/omni.ts`.
So on this hardware the browser's GPU is about 1.6 times faster than native CPU,
and its WebAssembly fallback about 15 times slower. Carrying those ratios across
puts the 578 patches at roughly 13 hours on WebGPU and roughly 320 hours, or 13
days, on WebAssembly.

Treat both browser figures as an order of magnitude rather than a measurement.
They chain a PyTorch timing onto an ONNX Runtime ratio, and ONNX Runtime is
usually the faster of the two for inference, so the WebGPU figure could
plausibly come in at half of what is quoted. Half of thirteen hours is still
thirteen hours too many for a tab that currently finishes in minutes, and the
WebAssembly path is not optional, because `omni.ts` falls back to it whenever
WebGPU is unavailable and a fair number of machines land there.

Memory is the least of the problems but worth stating. A 512 pixel block at 20
metres covers 10.24 kilometres, which at 2.5 metres is 4,096 pixels square, so a
four-band float32 working buffer is 268 MB per block. The assembled backdrop
would be 233 MB as RGBA for one composite and 466 MB for two, on an 8 GB machine,
and all of it discarded down to 2048 pixels at paint time.

### The recommendation

Do not add it. At 90,000 acres the honest upgrade is to build the two
true-colour backdrops on a 10 metre grid instead of the 20 metre working grid.
That costs a few hundred kilobytes more over HTTP, no model, no weights and no
extra seconds, and it lands within seven per cent of what thirteen hours of
diffusion would put on screen.

Super-resolution only starts to pay on a small subset of a large project, and
the 2048 pixel cap fixes exactly where that begins. A 2.5 metre layer fills the
cap at a square 5,120 metres on a side, which is 2,621 hectares or 6,478 acres.
Below that size the layer paints one to one and the operator genuinely sees 2.5
metres, four times finer than the native bands. Above it the cap starts eating
the gain, so 5,000 hectares shows at 3.5 metres and 36,422 hectares shows at 9.3
metres.

The cost falls away just as fast, because the patch count follows the area. A
250 hectare window is 8 patches for a pre and post pair, about 18 minutes on
this machine's CPU. A 1,000 hectare window is 18 patches and about 40 minutes.
A 2,624 hectare window, right at the cap, is 50 patches and just under two
hours.

That is the shape of the useful version. An operator runs the normal check over
the whole 90,000 acres at 20 metres, finds the High severity patches, and then
super-resolves one or two of them offline with `opensr-run` to look at what they
actually are, minutes of compute rather than days, and at a size where the
result is visible. It stays outside the analysis and outside the manifest, so
the reproducibility objection recorded above does not arise. Serving it inside
the panel at full project scale would additionally need a tiled backdrop at
several zoom levels rather than one capped texture, which is a change to how
layers are served rather than a change to the analysis.

## Running locally

Everything below runs on CPU, because this machine has no CUDA device.

The simplest form takes an input and a model name, where `LDSRS2` is the real
model and `None` substitutes bilinear interpolation, which is the right choice
for checking that a workflow is plumbed correctly before spending hours on it.

    opensr-run /path/to/scene.SAFE LDSRS2 --device cpu

The fuller form sets the patch size, the scale, the overlap and the border trim,
and asks for preview images.

    opensr-run /path/to/scene.tif LDSRS2 \
      --window_size 128 128 \
      --factor 4 \
      --overlap 12 \
      --eliminate_border_px 2 \
      --device cpu \
      --save_preview \
      --debug

Keep `--debug` on for a first run. It stops after about one hundred windows,
which turns an overnight job into a short one and still proves the output is
georeferenced and correctly scaled. Add `--overwrite` when re-running into a
folder that already holds an `sr.tif`, and `--keep_temp` when you want to look
at individual patches.

Input can be a `.SAFE` folder, a zipped `.SAFE`, an S2GM mosaic folder, or any
four-band red, green, blue, near-infrared raster that rasterio can open. The
package's own README warns that the model does not work properly on S2GM
mosaics.

From Python the same run reads as follows, and this is the form to use when the
model is being swapped for something other than LDSR-S2.

    from opensr_utils.model_utils.get_models import get_ldsrs2
    import opensr_utils

    model = get_ldsrs2(device="cpu")
    sr = opensr_utils.large_file_processing(
        root="/path/to/scene.tif",
        model=model,
        window_size=(128, 128),
        factor=4,
        overlap=12,
        eliminate_border_px=2,
        device="cpu",
        save_preview=True,
        debug=True,
    )
    sr.run()

Three reminders. Give it integer Sentinel-2 counts rather than float
reflectance, for the reason recorded above. Keep the portable SSD mounted,
because the editable install reads its code from there. Run from a working
directory that already holds `opensr-ldsrs2_v1_0_0.ckpt`, or that has 1.1 GB
free for it to be downloaded into, since the loader resolves the checkpoint
against the current directory rather than a shared cache.

On timing, run a small area first. One 128 pixel patch takes 133.6 seconds on
this machine, so a 500 hectare boundary is roughly nine minutes and a 5,000
hectare boundary roughly eighty. A whole Sentinel-2 tile is about fourteen days
and should not be attempted here.

## Running in QGIS

Do not install the package into QGIS's own Python. QGIS 4.2.1 on this machine
bundles its own interpreter at
`/Applications/QGIS-final-4_2_1.app/Contents/MacOS/python3.12`, and putting a
second PyTorch and a second rasterio into it risks breaking the application for
no gain, since none of this code needs anything QGIS provides.

Run the command line tool instead and load the result. Open the Python console
inside QGIS and call out to the interpreter that already has the package.

    import subprocess
    from qgis.core import QgsRasterLayer, QgsProject

    scene = "/path/to/scene.tif"
    out = "/path/to/output_folder"

    subprocess.run([
        "/Users/seamus/Library/Python/3.12/bin/opensr-run",
        scene, "LDSRS2", "--device", "cpu", "--factor", "4", "--debug",
    ], cwd=out, check=True)

    layer = QgsRasterLayer(f"{out}/sr.tif", "Super-resolved 2.5 m")
    QgsProject.instance().addMapLayer(layer)

The run blocks the QGIS interface until it finishes, which is fine for a debug
run and unacceptable for a full tile, so run full tiles in Terminal and simply
drag `sr.tif` onto the QGIS canvas afterwards. There is no plugin and no
Processing algorithm for this package, so a QGIS Processing toolbox entry would
have to be written from scratch.

## Google Earth Engine

Earth Engine cannot run this package. Its servers execute only Earth Engine's
own operations, so arbitrary PyTorch code has nowhere to run, and there is no
mechanism for uploading a checkpoint and calling it inside a `map` over an image
collection.

Two routes exist and they are very different in cost.

The straightforward one is to move the pixels. Export the four 10 metre bands
from Earth Engine to Drive or Cloud Storage with `Export.image.toDrive` or
`Export.image.toCloudStorage`, keeping the native integer values and the native
UTM projection rather than reprojecting to WGS 84, run `opensr-run` on the
downloaded GeoTIFF, and upload the result back as an Earth Engine asset if it
needs to be used there. For a project boundary rather than a whole tile this is
a small export and the round trip is uncomplicated.

The other route hosts the model on Google's own infrastructure and calls it from
Earth Engine. Google's current machine learning guide, read on 2026-09-06 at
`https://developers.google.com/earth-engine/guides/ml_examples`, documents
`ee.Model.fromVertexAiPredictor` for getting predictions from a model hosted on
Vertex AI directly inside Earth Engine, and names PyTorch as a supported
framework alongside TensorFlow. The older `ee.Model.fromAiPlatformPredictor` is
deprecated. The same page states that these guides use billable components
including Vertex AI, Cloud Storage and commercial Earth Engine, so this route
needs a Google Cloud billing account and a commercial Earth Engine licence. The
model also has to be reshaped for hosted prediction rather than deployed as it
comes, and a hundred-step diffusion model behind a request-response endpoint is
an awkward fit. For a verification workflow the export route is the sensible
one.

## SEN2SRLite

Notes written on 2026-09-06, after the assessment above, in answer to a second
question. The package is `sen2sr` from ESA OpenSR at
`https://github.com/ESAOpenSR/SEN2SR`, PyPI version 0.8.5, MIT licence, with
weights on Hugging Face under `tacofoundation/sen2sr`. It is the same group and
the same repository family as `opensr-utils` above, and LDSR-S2 is one of the
models it can load. SEN2SRLite is the other one, and it is a different kind of
thing entirely.

The short answer is that SEN2SRLite removes every objection the assessment above
raised except one, and the one it leaves standing is the 2048 pixel texture cap,
which is a property of the renderer rather than of the model.

### What changed

Think of the difference as a sketch artist against a photocopier with a good
lens. LDSR-S2 is the sketch artist, starting from static and drawing in detail
over a hundred passes, producing a slightly different drawing every time.
SEN2SRLite is the lens, one pass, same answer every time, no invention beyond
what a fixed filter puts back.

Five numbers set out the gap, all measured on this machine today.

| | LDSR-S2 | SEN2SRLite RGBN x4 |
|---|---|---|
| Parameters | 169,000,000 | 572,336 |
| Weights on disk | 1.1 GB checkpoint | 236 KB as ONNX |
| Passes per patch | 100 sampling steps plus a decode | 1 |
| One 128 by 128 patch | 133.6 s in PyTorch on CPU | 80 to 100 ms under ONNX Runtime on CPU |
| Two runs, same input | different every time | bitwise identical |

That is between 1,336 and 1,670 times faster and 4,657 times smaller, and it is
deterministic. The patch timing is quoted as a range because the median moved
between 80 ms and 100 ms across two sessions on this machine, and the costs below
use the slower figure.

### Three variants

SEN2SRLite ships as three models and they do different jobs. All three were
downloaded and run here.

1. `NonReference_RGBN_x4` took the four 10 metre bands, blue B02, green B03, red
   B04 and near-infrared B08, on a 128 by 128 patch, and returned them at 2.5
   metres as 512 by 512. It holds 572,336 parameters and took 364 ms per patch
   in PyTorch on CPU.
2. `Reference_RSWIR_x2` took all ten bands on a 128 by 128 patch at 10 metres and
   returned the six recorded at 20 metres, red-edge B05, B06 and B07, narrow
   near-infrared B8A, and short-wave infrared B11 and B12, sharpened to 10
   metres. It holds 566,554 parameters and took 186 ms per patch in PyTorch, 12
   ms under ONNX Runtime.
3. `main` chained the two and added a third stage, taking ten bands in at 10
   metres and returning ten bands at 2.5 metres. It holds 1,705,444 parameters
   and took 3.30 s per patch in PyTorch on CPU.

The second of these is the one the assessment above could not have, because
LDSR-S2 touches only the four 10 metre bands. NDMI is built from B08 and B11 and
NBR from B8A and B12, and all three of B8A, B11 and B12 are in the set this
model sharpens.

### Porting to ONNX

Every model in `vendor/` is an ONNX file, so the test that mattered was whether
SEN2SRLite converts. It does, and the conversion was verified rather than
assumed.

The network itself is SPAN, a plain convolutional stack of ten convolutions,
six sigmoid gates, a `DepthToSpace` upsampler and some arithmetic, exported by
the legacy tracer at opset 20 into a 220 KB file that matched PyTorch to a
maximum absolute difference of 6.6e-07 on the real Sentinel-2 sample the package
ships.

The wrapper around it was the hard part and turned out not to be. Both models
apply a `HardConstraint` that replaces the low frequencies of the network's
output with the low frequencies of the bicubically enlarged input, so the coarse
radiometry of the result is the measurement rather than the model's guess. It is
written with `torch.fft`, which the ONNX exporter refuses, and with
`torch.nn.functional.interpolate` in antialiased bicubic mode, which the exporter
also refuses, raising `Exporting the operator 'aten::_upsample_bicubic2d_aa' to
ONNX opset version 20 is not supported`.

Both refusals were sidestepped by writing the same operation with different
arithmetic. The stored low-pass mask is a Gaussian, so its spatial kernel is
compact, and 100.000 per cent of the kernel's energy for the x4 model sits inside
a 31 by 31 window, 99.999 per cent inside 15 by 15. The constraint is therefore
one fixed depthwise convolution rather than a pair of Fourier transforms.
Separately, the antialiased bicubic enlargement by a factor of four proved to be
exactly a 16 by 16 transposed convolution of stride 4, recovered by pushing a
single bright pixel through it and reading the response.

Rebuilt that way and exported, the whole composite, constraint included, came to
236 KB and matched the model as ESA ships it to a maximum absolute difference of
5.96e-07 across the interior of the patch, which is float32 rounding. The 20
metre to 10 metre model was rebuilt the same way, came to 201 KB, and matched to
9.5e-07. Both reproduced bitwise on rerun. The comparisons excluded a 32 pixel
border, where the padding rule differs from the circular wrap the Fourier version
implies, and that border is discarded by the tiler in any case.

One thing is not yet proven. Four operators in these graphs, `ConvTranspose`,
`DepthToSpace`, `Pad` and `ConstantOfShape`, appear in neither
`ocm-v4-regnety.onnx` nor `ocm-v4-edgenext.onnx`, so nothing in this repository
demonstrates that ONNX Runtime Web's WebGPU backend implements them. That is the
one open question before an in-tab build, and it has an escape route, since
`ConvTranspose` can be written as the `Resize` the cloud models already use, the
`Pad` disappears if the tile is enlarged before it enters the graph, and
`ConstantOfShape` is an artefact of that same padding.

### Accuracy measured

Two comparisons were run against the reference pair the package ships, one 128 by
128 low-resolution patch with its true 512 by 512 counterpart. Both are a single
sample and should be read as such.

On radiometric fidelity the constrained model is the best of the three. Averaging
each 4 by 4 block of the output back down to the input grid, the constrained
output differed from the measured input by a mean of 0.00159 in reflectance,
against 0.00237 for plain bicubic enlargement and 0.00435 for the network without
its constraint, on a scene whose mean reflectance was 0.168. The constraint is
doing real work and it is the reason the output can be called a refinement of the
measurement rather than a picture next to it.

On pixel error against the true high-resolution image the gain over doing nothing
is small. The constrained model reached a mean absolute error of 0.01370 and a
root mean square error of 0.02151, against 0.01434 and 0.02242 for bicubic
enlargement, an improvement of 4.5 per cent in mean absolute error. Super
resolution is not bought for pixel error, it is bought for apparent sharpness,
which these two statistics do not measure, but the honest statement is that on
this sample the numeric gain over free bicubic was modest.

### Cost at scale

The arithmetic follows the earlier section and uses the same 90,000 acre
worked example, 36,422 hectares, a square 19,084 metres on a side, which is 1,908
pixels on the 10 metre grid. With a 128 pixel window and 12 pixels of overlap the
stride is 116, giving 17 patches a side, 289 per composite and 578 for a pre and
a post window together.

At the measured 100 ms per patch under ONNX Runtime on this machine's CPU, the
2.5 metre backdrop for both windows costs 57.8 seconds. Carrying across the ratios
recorded in `src/raster/omni.ts`, where the two cloud models ran a 512 block in
263 ms on WebGPU and 6,301 ms on WebAssembly against 423 ms under ONNX Runtime on
this CPU, gives roughly 36 seconds on WebGPU and roughly 14 minutes on the
WebAssembly fallback. The equivalent figures for LDSR-S2 were 21.5 hours natively
and about 13 days on WebAssembly.

The 20 metre to 10 metre model is cheaper still. At 12 ms per patch the same 578
patches cost 6.9 seconds on this CPU, about 4 seconds on WebGPU and about 1.7
minutes on WebAssembly.

The weights are the other half of the cost and they have stopped mattering. The
two files together are 437 KB, against the 60 MB of cloud models the tab already
downloads, so the super-resolution weights would add seven tenths of one per cent
to the weight budget. LDSR-S2 would have added 1,833 per cent.

### What still fails

The display cap is untouched and the earlier finding stands. `buildWarp` in
`src/render/paint.ts` line 84 takes a maximum dimension of 2048 pixels and
`src/analysis/run.ts` line 341 calls it with that default, so a 36,422 hectare
project super-resolved to 2.5 metres is 7,634 pixels, scaled down by 0.268 and
painted at 2048, showing the operator 9.3 metres per screen pixel. Reading the
same bands at their native 10 metres, with no model at all, shows 10.0 metres per
screen pixel. At full project scale the model buys seven per cent, and every
invented pixel is discarded before anyone sees it. That was true of LDSR-S2 and
it is true of SEN2SRLite, because it is a fact about the renderer.

What has changed is the cost of the case where the cap is not binding. The 2.5
metre layer fills 2048 pixels at a square 5,120 metres on a side, which is 2,621
hectares or 6,477 acres, and below that size the layer paints one to one and the
operator genuinely sees 2.5 metres. A window at exactly that size is 25 patches
per composite and 50 for a pair, which the earlier section priced at just under
two hours and which now costs 5 seconds on this CPU. A 250 hectare window is 8
patches, 0.8 seconds against the 18 minutes recorded above.

### The three options

The three things that could be built are worth separating, because they have very
different risk.

The first is an on-demand 2.5 metre backdrop over a selected window, capped at
about 6,477 acres, run when an operator clicks a High severity patch to see
whether it is a cutblock, a road, a windthrow gap or a shadow. It costs 236 KB of
weights and single-digit seconds, it sits outside the analysis and outside the
manifest, and it is the version the earlier section pushed offline purely on cost.
The cost argument no longer holds and this is the one worth building first.

The second is moving the analysis grid from 20 metres to 10 metres by running
`Reference_RSWIR_x2` on the six bands recorded at 20 metres. This is the option
the earlier assessment could not consider, and it is the only one that touches
the numbers. `ANALYSIS_SCALE` in `src/defaults.ts` is 20, which is the native
resolution of B11, B12 and SCL, and it is the reason the hectare counts and the
histogram are computed at 20 metres. Sharpening those bands to 10 metres would
quadruple the resolution of the classification, at 12 ms per patch and 201 KB of
weights, and unlike the x4 model it invents nothing finer than a band the
satellite already records at that spacing. It would need three assets the app
does not currently fetch, since `REQUIRED_ASSETS` in `src/stac/search.ts` lists
seven bands and the model wants B05, B06 and B07 as well.

The third is the full 2.5 metre analysis, and it should not be built. Feeding 2.5
metre pixels into a reduction that runs at 20 metres averages the invented detail
straight back out, which was the second finding of the earlier assessment and is
unaffected by which model produced the pixels.

### Before the numbers move

The second option deserves a caution that the first does not. A model-sharpened
B11 feeding NDMI feeding a hectare count in an ACR verification deliverable is a
different kind of claim from a backdrop an operator looks at, and it needs its own
validation before it goes anywhere near a finding. The reproducibility objection
is answered, because the model is one deterministic pass whose weights have a file
hash the manifest can record exactly as `src/raster/omni.ts` already records which
execution provider ran. Determinism was confirmed here under PyTorch on CPU and
under ONNX Runtime on CPU; it was not tested on WebGPU, and small floating point
differences between execution providers should be expected rather than assumed
away, which is why the provider belongs in the manifest.

What is not answered is whether the sharpened bands give the same answer as the
measured ones. The test that would answer it is to run the existing 20 metre
analysis and a 10 metre analysis over the same boundaries and reporting periods,
and to compare the class areas in hectares and the severity histogram directly,
on enough project boundaries to see whether the disagreement is a bias or noise.
Until that has been run and read, the 20 metre analysis is the one that goes in a
deliverable.

### Reproducing this

The package was installed for the MacPorts Python 3.12 with
`python3 -m pip install --user sen2sr mlstac`, which added `sen2sr` 0.8.5,
`mlstac` 0.4.9 and the `pystac` family, and left `torch` 2.13.0, `numpy` 2.4.6 and
`onnxruntime` 1.28.0 alone. The `cubo` dependency the README lists was skipped
because it only builds Sentinel-2 data cubes and this repository has its own
reader.

The three model folders were fetched with `mlstac.download` from
`https://huggingface.co/tacofoundation/sen2sr/resolve/main/SEN2SRLite/<variant>/mlm.json`
and came to 9.3 MB, 7.5 MB and 2.9 MB on disk, the bulk of which is the example
data rather than the weights.

`scripts/export-sen2sr-model.py` rebuilds both portable models, exports them,
checks each against the model ESA ships and prints the timings quoted above. It
follows `scripts/export-cloud-model.py`, which checks its conversion before
keeping it, and like that script it writes nothing unless the check passes.

One trap is worth recording. `torch.onnx.export` with `dynamo=True`, which is the
default in torch 2.13, segfaulted this interpreter on every attempt, dying with
`EXC_BAD_ACCESS` at a null address inside `direct_copy_kernel` in
`libtorch_cpu.dylib` during the decomposition step. It is not memory pressure, as
the process held 3.3 GB on an 8 GB machine. Pass `dynamo=False` and the legacy
tracer exports both models without complaint.
