import React from 'react'
import { Tabs } from 'expo-router'
import { useStore } from '@nanostores/react'
import { C, themeVersion } from '../../src/lib/theme'
import { thinkerAtom } from '../../src/lib/thinker'

/**
 * The tab bar is hidden: navigation moved into the ChatGPT-style drawer, so
 * the conversation gets the full height of the screen. The tab navigator is
 * kept because the drawer routes to these screens.
 *
 * When the thinker is OpenCode (OPENCODE-MODE contract), the hermes-only
 * surfaces (crew, fleet, agent, sessions, automations, skills, connectors,
 * inbox) drop out of the tab registry with `href: null` — still routed for
 * deep links, but not part of this app's surface. Chat, Terminal, Settings
 * stay — and so does the Browser (issue 15): OpenCode drives it through the
 * moch-browser MCP adapter (oc_browser_mcp + the CDP relay), so the screen
 * is the tool's live target, not a hermes-only surface.
 */
export default function TabsLayout() {
  // Subscribe so a theme switch re-reads C.bg for the scene backgrounds —
  // nothing else re-rendered this layout when the tokens mutated.
  useStore(themeVersion)
  const thinker = useStore(thinkerAtom)
  const ocHidden = thinker === 'opencode' ? { href: null } : undefined
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: C.bg },
        tabBarStyle: { display: 'none' },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen name="chat" />
      <Tabs.Screen name="crew" options={ocHidden} />
      <Tabs.Screen name="fleet" options={ocHidden} />
      <Tabs.Screen name="browser" />
      <Tabs.Screen name="sessions" options={ocHidden} />
      <Tabs.Screen name="agent" options={ocHidden} />
      <Tabs.Screen name="terminal" />
      <Tabs.Screen name="automations" options={ocHidden} />
      <Tabs.Screen name="skills" options={ocHidden} />
      <Tabs.Screen name="connectors" options={ocHidden} />
      <Tabs.Screen name="inbox" options={ocHidden} />
      <Tabs.Screen name="settings" />
    </Tabs>
  )
}
