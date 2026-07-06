// Neutral, dependency-free Pro constants. Extracted from pro-colocation.ts so
// that modules which need only a constant (e.g. admin.ts's pricing route) don't
// have to statically import the co-location engine — which pulls in the cloud
// provisioning moat (pro-provisioner, hetzner-provisioner, pro-state-backup).
//
// Keeping this file free of cloud imports is what lets the standalone/self-host
// build type-check without shipping any of the Pro provisioning source.

// A single Pro VPS hosts up to this many co-located agents at one flat price;
// a further agent needs another server.
export const PRO_VPS_AGENT_CAP = 3
