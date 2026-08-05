// The Earth Engine JavaScript client publishes no TypeScript definitions. The
// client is a dynamic expression-graph builder whose surface is not usefully
// expressible in static types, so it is declared as `any` here and constrained
// at the boundaries in src/ee/.
declare module "@google/earthengine" {
  const ee: Record<string, any>;
  export default ee;
}
