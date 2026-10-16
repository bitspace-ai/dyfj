import process from "node:process";

if (process.argv.includes("--help")) {
  console.log("usage: npm run smoke\n\nPrints the Node version DYFJ runs on.");
  process.exit(0);
}
console.log("DYFJ Node smoke test");
console.log(`Node ${process.versions.node}`);
