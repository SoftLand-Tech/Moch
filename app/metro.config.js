const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// videos/ is a promo-video workspace, not app code. Metro's fallback file
// watcher crashed (ENOENT → process exit) when temp files there vanished
// mid-watch, so keep it out of both the bundle and the watcher.
config.resolver.blockList = [/[/\\]videos[/\\]/]

module.exports = config
