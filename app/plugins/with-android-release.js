// Keeps our native Android customizations alive across `expo prebuild` syncs —
// prebuild regenerates the gradle files and silently reverts hand-applied
// edits, so everything this repo needs beyond the stock template is re-applied
// here on every prebuild:
//   1. release signing read from android/keystore.properties (gitignored;
//      keystore itself lives outside the repo), debug-key fallback otherwise
//   2. ndkVersion pinned to the full 27.1 install (RN's catalog default can
//      resolve to 27.0.12077973, which exists on some machines as a broken
//      stub without source.properties)
//   3. expo-updates gets the same ndkVersion — its build.gradle never sets
//      one, so AGP falls back to its compiled-in default and CXX1101s on the
//      stub above
//   4. FCM wiring: the google-services gradle plugin + classpath and the
//      android-app apply, so expo-notifications can mint FCM tokens (the
//      config file itself is committed at android/app/google-services.json)
const {
  withAppBuildGradle,
  withProjectBuildGradle,
  withGradleProperties,
} = require("expo/config-plugins");

const NDK_VERSION = "27.1.12297006";

const KEYSTORE_PROPS_BLOCK = `

// Managed by plugins/with-android-release.js. Release signing lives in
// keystore.properties (gitignored) so the keystore never enters the repo.
// Absent the file, release falls back to the debug key so contributor
// builds still run.
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.withInputStream { keystoreProperties.load(it) }
}`;

const RELEASE_SIGNING_CONFIG_BLOCK = `        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
`;

const RELEASE_BUILD_TYPE_SNIPPET = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

const RELEASE_BUILD_TYPE_REPLACEMENT = `            signingConfig keystorePropertiesFile.exists() ? signingConfigs.release : signingConfigs.debug`;

const PROJECT_GRADLE_OVERRIDE = `
// Managed by plugins/with-android-release.js. expo-updates never sets
// ndkVersion, so AGP falls back to its compiled-in default (27.0.12077973) —
// which can exist as a broken stub on dev machines. Set it at plugin-apply
// time (before its build.gradle and CMake config run) to the NDK the rest of
// the project already resolves to.
subprojects { sp ->
  sp.plugins.withId('com.android.library') {
    if (sp.path == ':expo-updates') {
      sp.extensions.findByName('android').ndkVersion =
        rootProject.ext.has('ndkVersion') ? rootProject.ext.ndkVersion : '${NDK_VERSION}'
    }
  }
}
`;

const withAndroidRelease = (config) => {
  // Bare workflow builds reject runtimeVersion policies; resolve the
  // appVersion policy to the literal version so OTA runtime tracking stays
  // version-bound while satisfying EAS.
  if (config.runtimeVersion && typeof config.runtimeVersion === "object") {
    config.runtimeVersion = config.version;
  }

  config = withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (!contents.includes("keystorePropertiesFile")) {
      contents = contents.replace(
        "def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()",
        `def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()${KEYSTORE_PROPS_BLOCK}`
      );
    }
    if (!contents.includes("signingConfigs.release")) {
      contents = contents.replace(
        "    signingConfigs {\n        debug {",
        `    signingConfigs {
${RELEASE_SIGNING_CONFIG_BLOCK}        debug {`
      );
      contents = contents.replace(
        RELEASE_BUILD_TYPE_SNIPPET,
        RELEASE_BUILD_TYPE_REPLACEMENT
      );
    }
    cfg.modResults.contents = contents;
    return cfg;
  });

  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(":expo-updates")) {
      cfg.modResults.contents += PROJECT_GRADLE_OVERRIDE;
    }
    // FCM: the google-services gradle plugin reads
    // android/app/google-services.json at build time; expo-notifications
    // needs it to register with FCM and mint Expo push tokens.
    if (!cfg.modResults.contents.includes("com.google.gms.google-services")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies \{/,
        `dependencies {
        classpath("com.google.gms:google-services:4.4.2")
`
      );
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    // FCM: apply the plugin after the android-application plugin. Idempotent
    // across prebuild regenerations.
    if (!cfg.modResults.contents.includes("com.google.gms.google-services")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        'apply plugin: "com.facebook.react"',
        'apply plugin: "com.facebook.react"\napply plugin: "com.google.gms.google-services"'
      );
    }
    return cfg;
  });

  config = withGradleProperties(config, (cfg) => {
    if (!cfg.modResults.some((item) => item.key === "ndkVersion")) {
      cfg.modResults.push({
        type: "property",
        key: "ndkVersion",
        value: NDK_VERSION,
      });
    }
    // Release APK size: arm64-v8a is the only ABI real phones need (the
    // universal APK carried ~59MB of emulator-only x86 libs). Unlike
    // recipe-meal, android/ is committed here so no prebuild runs on EAS —
    // the value must live in the committed gradle.properties, not be gated
    // on EAS_BUILD_PROFILE. Emulator dev builds: pass
    // -PreactNativeArchitectures=x86_64 to gradle.
    if (!cfg.modResults.some((item) => item.key === "reactNativeArchitectures")) {
      cfg.modResults.push({
        type: "property",
        key: "reactNativeArchitectures",
        value: "arm64-v8a",
      });
    } else {
      for (const item of cfg.modResults) {
        if (item.key === "reactNativeArchitectures") item.value = "arm64-v8a";
      }
    }
    return cfg;
  });

  return config;
};

module.exports = withAndroidRelease;
