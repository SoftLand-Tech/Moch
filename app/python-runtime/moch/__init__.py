"""Moch embedded runtime package.

Lives outside app/android/ on purpose: android/ is expo-prebuild output and
would be regenerated away; this tree is referenced from the Gradle config as
a Chaquopy source dir and is the eventual home of the vendored hermes agent
(Milestone 2+).
"""
