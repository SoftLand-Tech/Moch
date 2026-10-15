/**
 * 'expo' package shim: the shared engine lazily requires('expo') in a few
 * push/notifications paths. On desktop those paths must resolve to
 * something harmless — an empty namespace keeps the require answerable
 * without pulling React Native into the bundle.
 */
export default {}
export const Notifications = undefined
