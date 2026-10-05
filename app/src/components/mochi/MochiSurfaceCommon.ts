import type React from 'react'
import type { MochiStateName } from './mochiStates.gen'

export interface MochiSurfaceProps {
  /** Desired mascot state — injected over the bridge only when it differs
   *  from the last-injected one (messages re-evaluations recompute equal
   *  states and must not spam the bridge; injection is idempotent anyway). */
  state: MochiStateName
}

export interface MochiSurfaceHandle {
  /** Dev-only: drive the document straight to a state (the __DEV__
   *  state-picker sheet). Buffered until the document loads, like `state`. */
  force: (name: MochiStateName) => void
}

export type MochiSurfaceComponent = React.ForwardRefExoticComponent<
  MochiSurfaceProps & React.RefAttributes<MochiSurfaceHandle>
>
