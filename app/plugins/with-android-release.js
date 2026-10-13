// Keeps our native Android customizations alive across `expo prebuild` syncs —
// prebuild regenerates the gradle files and silently reverts hand-applied
// edits, so everything this repo needs beyond the stock template is re-applied
// here on every prebuild:
//   1. release signing requires android/keystore.properties (gitignored;
//      keystore itself lives outside the repo) — NO debug-key fallback: a
//      release task without it fails the gradle build at configuration time
//      (C-04 / GitHub #94); EAS Build injects its own signing via
//      eas-build.gradle, so it is exempt from the gate. The stock template's
//      explicit debug signingConfig (committed debug.keystore) is removed —
//      AGP auto-creates the default ~/.android/debug.keystore
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

// Managed by plugins/with-android-release.js. Release signing requires
// android/keystore.properties (gitignored — see app/android/.gitignore) so
// the real keystore never enters the repo. There is NO debug-key fallback
// (C-04 / #94): release tasks fail fast below when the file is missing —
// use assembleDebug for local development builds.
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.withInputStream { keystoreProperties.load(it) }
}

// C-04 / #94: fail fast at CONFIGURATION time when the requested tasks
// build a release variant but keystore.properties is absent — release
// signing used to silently fall back to the debug key here. Gated on the
// requested task names so \`assembleDebug\`, \`:app:tasks\` and IDE sync
// configure fine. EAS Build is exempt: with EAS-managed credentials it
// never writes keystore.properties — it appends \`apply from:
// "./eas-build.gradle"\` which injects release signing from credentials.json
// after this script has run.
def requestedTasks = gradle.startParameter.taskNames.collect { it.substring(it.lastIndexOf(':') + 1).toLowerCase(Locale.ROOT) }
def wantsReleaseTask = requestedTasks.any { it.contains("release") || it in ["assemble", "bundle", "build"] }
if (wantsReleaseTask && !keystorePropertiesFile.exists()
        && !file("eas-build.gradle").exists()
        && System.getenv("EAS_BUILD") != "true") {
    throw new GradleException(
        "Release signing requires android/keystore.properties (storeFile, storePassword, keyAlias, keyPassword), which is missing. " +
        "See app/plugins/with-android-release.js and app/README.md. " +
        "Refusing to fall back to the debug signing key (C-04 / GitHub #94). " +
        "For local development builds use :app:assembleDebug instead.")
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

// The stock expo template pins its own debug.keystore ('android'
// passwords) with an explicit debug signingConfig — the file used to be
// committed here. C-04 / #94: drop the block so AGP falls back to the
// default auto-created ~/.android/debug.keystore instead.
const STOCK_DEBUG_SIGNING_CONFIG_BLOCK = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
`;

const DEBUG_SIGNING_CONFIG_REPLACEMENT = `        // No explicit debug signingConfig (C-04 / #94): AGP auto-creates and
        // signs debug builds with the default ~/.android/debug.keystore. The
        // old block pinned the stock-template debug.keystore ('android'
        // passwords) that used to be committed at app/debug.keystore — it is
        // untracked now.
`;

const RELEASE_BUILD_TYPE_SNIPPET = `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

const RELEASE_BUILD_TYPE_REPLACEMENT = `            // C-04 / #94: no debug-key fallback — keystore.properties is
            // required (the gate at the top of this file fails the build
            // without it).
            signingConfig signingConfigs.release`;

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
      // C-04 / #94: also drop the stock debug signingConfig (template
      // debug.keystore) — see the constants above.
      contents = contents.replace(
        STOCK_DEBUG_SIGNING_CONFIG_BLOCK,
        DEBUG_SIGNING_CONFIG_REPLACEMENT
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
