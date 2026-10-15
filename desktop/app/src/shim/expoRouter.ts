/**
 * expo-router shim: openInBrowser.ts (shared lib) imports expo-router at
 * module scope for link helpers. Desktop navigation is shell-state based,
 * so the surface answers with inert stubs.
 */
import type { FC, ReactNode } from 'react'

export const Link: FC<{ href: string; children?: ReactNode; target?: string }> = () => null

export const router = {
  push(): void {},
  back(): void {},
  replace(): void {},
  navigate(): void {},
  canGoBack(): boolean {
    return false
  },
}
