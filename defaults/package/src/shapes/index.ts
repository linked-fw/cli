// Shape registry — every shape in this package is imported here so its @linkedShape
// decorator runs and the shape registers on BOTH boot paths: the backend entry
// (src/backend.ts, which materializes shapes into app-data on boot) and the frontend
// entry. Apps load the whole set with `import '<package>/shapes/index'`.
// Side-effect imports only: no exports, components or providers. `linked create-shape`
// maintains the list below, and `linked build` fails when a shape module is missing.
//SHAPES
