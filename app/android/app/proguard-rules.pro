# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# @generated begin expo-build-properties - expo prebuild (DO NOT MODIFY)
-keep class expo.modules.updates.** { *; }
-keep class expo.modules.updates-interface.** { *; }
# @generated end expo-build-properties
# Chaquopy Python->Java interop: methods called from Python must survive
# R8 renaming (the release build renamed knock() and broke automations
# knocks silently — (R8 renamed knock(); Python lookup failed)).
-keep class com.hermes.pocket.hermes.CronKnockNotifier { public *; }
