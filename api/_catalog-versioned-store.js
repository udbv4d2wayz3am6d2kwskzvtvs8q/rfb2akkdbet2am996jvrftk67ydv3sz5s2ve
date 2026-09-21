// Atomic compare-and-swap lives in Postgres; public snapshots live on jsDelivr.
export { readCatalog, writeCatalog } from "./_catalog-store.js";
