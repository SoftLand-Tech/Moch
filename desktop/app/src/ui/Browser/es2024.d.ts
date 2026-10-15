// tsconfig pins lib to ES2022, but every runtime this app targets (the
// chrome120 vite build, current WebKitGTK) implements ES2024's
// Promise.withResolvers. Declare its types so code can use the real API;
// delete this file once tsconfig bumps lib to es2024.

interface PromiseWithResolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface PromiseConstructor {
  withResolvers<T>(): PromiseWithResolvers<T>
}
