/** Models surface — provider/model browser over the shared modelState.
 * Scope note: session/once scopes need a live session id (the BH-000088
 * class of bug writes the profile default instead); until the desktop
 * chat's live id is plumbed here, picks are global — the phone's own
 * global-write contract. */
import React, { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  liveModel,
  liveProvider,
  modelOptions,
  modelOptionsLoading,
  hookModelState,
  fetchModelOptions,
  applyModel,
} from '../../../../../app/src/lib/modelState'

export default function Models(): React.JSX.Element {
  const opts = useStore(modelOptions)
  const loading = useStore(modelOptionsLoading)
  const live = useStore(liveModel)
  const liveProv = useStore(liveProvider)
  const [provider, setProvider] = useState<string>('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const off = hookModelState()
    void fetchModelOptions()
    return off
  }, [])

  const providers = opts?.providers ?? []
  const effectiveProvider = provider || liveProv || providers[0]?.slug || ''
  const current = providers.find((p) => p.slug === effectiveProvider)
  const models = current?.models ?? current?.featured_models ?? []

  const pick = async (modelId: string): Promise<void> => {
    setError('')
    setBusy(modelId)
    try {
      let res = await applyModel({ sessionId: '', model: modelId, provider: effectiveProvider, scope: 'global' })
      if ('needsConfirm' in res && res.needsConfirm) {
        res = await applyModel({
          sessionId: '',
          model: modelId,
          provider: effectiveProvider,
          scope: 'global',
          confirmed: true,
        })
      }
      if ('error' in res && res.error) setError(String(res.error))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="screen" style={{ padding: 24 }}>
      <h2 className="screen-title">Models</h2>
      <p className="screen-empty">
        Live: {liveProv ? `${liveProv} / ${live}` : 'none'}
        {error ? ` · ${error}` : ''}
      </p>
      {loading && providers.length === 0 ? (
        <p className="screen-empty">Loading providers…</p>
      ) : providers.length === 0 ? (
        <p className="screen-empty">No providers configured yet. Add a key from the gateway.</p>
      ) : (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220 }}>
            <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)' }}>PROVIDERS</h3>
            {providers.map((p) => (
              <div
                key={p.slug}
                role="button"
                tabIndex={0}
                onClick={() => setProvider(p.slug)}
                onKeyDown={(e) => e.key === 'Enter' && setProvider(p.slug)}
                className={p.slug === effectiveProvider ? 'model-row active' : 'model-row'}
              >
                {p.name || p.slug}
                {p.is_current ? ' ✓' : ''}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)' }}>
              {(current?.name || effectiveProvider).toUpperCase()} MODELS
            </h3>
            {models.length === 0 ? (
              <p className="screen-empty">No models listed for this provider.</p>
            ) : (
              models.map((m) => (
                <div
                  key={m}
                  role="button"
                  tabIndex={0}
                  onClick={() => void pick(m)}
                  onKeyDown={(e) => e.key === 'Enter' && void pick(m)}
                  className={m === live ? 'model-row active' : 'model-row'}
                >
                  {m}
                  {busy === m ? ' …' : ''}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <p className="screen-empty" style={{ marginTop: 16 }}>
        Session and once scopes land with the chat live-id plumbing (deferred — the global
        write is the contract the gateway confirms).
      </p>
    </div>
  )
}
