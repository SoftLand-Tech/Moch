import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootDesktop, connectionState } from './core/boot'
import { sessionRows } from '../../../app/src/lib/sessionList'

declare const beacon: (msg: string) => void

void bootDesktop().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
  setTimeout(() => {
    beacon('state ' + connectionState.get() + ' rows=' + sessionRows.get().length)
    beacon('href=' + location.href + ' domlen=' + document.body.innerHTML.length + ' title=' + document.title)
  }, 4000)
})
