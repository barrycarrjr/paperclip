// Tests never reach the public model catalog or spawn a provider CLI to read
// its model list: either would make results depend on the network and on
// whatever is installed on the machine running the suite. Tests that exercise
// discovery switch it back on for themselves and supply fake sources.
process.env.PAPERCLIP_MODEL_CATALOG_URL ??= "off";
process.env.PAPERCLIP_MODEL_CLI_DISCOVERY ??= "off";
