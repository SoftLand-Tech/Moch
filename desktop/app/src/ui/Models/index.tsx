/** Models surface — provider/model browser over the shared modelState. */
import React, { useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  liveModel,
  liveProvider,
  modelOptions,
  modelOptionsLoading,
  hookModelState,
  fetchModelOptions,
  type ModelScope,
} from '../../../../../app/src/lib/modelState'

export default function Models(): React.JSX.Element {
  const opts = useStore(modelOptions)
  const loading = useStore(modelOptionsLoading)
  const live = useStore(liveModel)
  const liveProv = useStore(liveProvider)
  const [provider, setProvider] = useState<string>('')
  const [scope, setScope] = useState<ModelScope>('global')
  const [error, setError] = useState('')

  useEffect(() => {
    const off = hookModelState()
    void fetchModelOptions()
    return off
  }, [])

  const providers = Array.from(new Set((opts?.models ?? []).map((m) => m.provider))).sort()
  const effectiveProvider = provider || liveProv || providers[0] || ''
  const models = (opts?.models ?? []).filter((m) => m.provider === effectiveProvider)

  const pick = async (modelId: string): Promise<void> => {
    setError('')
    try {
      const { setModel } = await import('../../../../../app/src/lib/modelState')
      await setModel({ provider: effectiveProvider, model: modelId, scope })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="screen" style={{ padding: 24 }}>
      <h2 className="screen-title">Models</h2>
      <p className="screen-empty">
        Live: {liveProv ? `${liveProv} / ${liveModel.get() || live}` : 'none selected'} · scope{' '}
        {scope}
      </p>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {(['global', 'session', 'once'] as ModelScope[]).map((s) => (
          <button
            key={s}
            className={s === scope ? 'btn primary' : 'btn'}
            onClick={() => setScope(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {loading && (opts?.models ?? []).length === 0 ? (
        <p className="screen-empty">Loading providers…</p>
      ) : providers.length === 0 ? (
        <p className="screen-empty">No providers configured yet. Add a key from the gateway.</p>
      ) : (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 220 }}>
            <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)' }}>PROVIDERS</h3>
            {providers.map((p) => (
              <div
                key={p}
                onClick={() => setProvider(p)}
                className={p === effectiveProvider ? 'model-row active' : 'model-row'}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setProvider(p)}
              >
                {p}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <h3 style={{ fontSize: 12, color: 'var(--moch-text-dim)' }}>
              {effectiveProvider.toUpperCase()} MODELS
            </h3>
            {models.map((m) => (
              <div
                key={m.id}
                onClick={() => void pick(m.id)}
                className={m.id === live ? 'model-row active' : 'model-row'}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && void pick(m.id)}
              >
                {m.id}
              </div>
            ))}
          </div>
        </div>
      )}
      {error ? <p style={{ color: 'var(--moch-red)' }}>{error}</p> : null}
    </div>
  )
}
