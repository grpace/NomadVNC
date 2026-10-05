const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// pnpm monorepo: workspace packages (@nomadvnc/*) live in ../../packages and
// every dependency's real files live under the root node_modules/.pnpm store,
// reached through symlinks. Metro must watch both and follow the links.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = {
  watchFolders: [path.join(workspaceRoot, "packages"), path.join(workspaceRoot, "node_modules")],
  resolver: {
    nodeModulesPaths: [path.join(projectRoot, "node_modules"), path.join(workspaceRoot, "node_modules")],
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
