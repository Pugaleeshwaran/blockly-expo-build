// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * We want Metro to treat .html/.xml and our large vendor .bundle files as
 * static assets (not transformable JS). This allows <script src="..."> in
 * our WebView HTML to load them locally on Android/iOS.
 */
config.resolver.assetExts = [...config.resolver.assetExts, 'html','xml','bundle','css'];


module.exports = config;
