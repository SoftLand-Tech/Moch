/**
 * SettingsOverlay — the account row's door at the rail's foot. One calm
 * scrim, a section nav on the inline-start side (Rakazo's shape), and the
 * existing views mounted whole inside: general, models, connectors, skills.
 * Only the models panel is native here; it picks the default model through
 * the same lib calls the composer's picker uses.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import { Check, Cpu, Plug, Settings, Sparkles, X } from 'lucide-react'
import ConnectorsView from '../views/ConnectorsView'
import SettingsView from '../views/SettingsView'
import SkillsView from '../views/SkillsView'
import { rpc } from '../lib/gateway'
import { currentModel, providers, refreshModels } from '../lib/model'
import { locale, tr } from '../lib/strings'

export type SettingsSection = 'general' | 'models' | 'connectors' | 'skills'

/** The section registry drives the nav and the body mount in one place. */
const SECTIONS: { id: SettingsSection; labelKey: string; icon: typeof Cpu }[] = [
  { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
  { id: 'models', labelKey: 'settings.nav.models', icon: Cpu },
  { id: 'connectors', labelKey: 'nav.connectors', icon: Plug },
  { id: 'skills', labelKey: 'nav.skills', icon: Sparkles },
]

export default function SettingsOverlay({ section, opener, onClose }: {
  section: SettingsSection
  opener?: HTMLElement | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<SettingsSection>(section)
  const modalRef = useRef<HTMLDivElement>(null)
  useStore(locale)

  useEffect(() => { modalRef.current?.focus() }, [])

  const close = () => {
    onClose()
    ;(opener ?? document.querySelector<HTMLElement>('.rk-account'))?.focus()
  }

  // Escape closes — unless a nested modal (a provider key or add-server
  // dialog inside the mounted views) is the scrim actually being dismissed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelectorAll('.scrim').length > 1) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div
        className="modal rk-settings"
        role="dialog"
        aria-modal="true"
        aria-label={tr('nav.settings')}
        ref={modalRef}
        tabIndex={-1}
      >
        <nav className="rk-set-nav" aria-label={tr('nav.settings')}>
          <div className="rk-set-me">
            <span style={{ flex: 1 }}>{tr('settings.account')}</span>
            <button className="btn ghost sm" onClick={close} aria-label={tr('settings.close')}>
              <X size={14} />
            </button>
          </div>
          {SECTIONS.map((s) => {
            const Icon = s.icon
            const on = tab === s.id
            return (
              <button
                key={s.id}
                className={on ? 'on' : ''}
                role="tab"
                aria-selected={on}
                onClick={() => setTab(s.id)}
              >
                <Icon size={14} /> {tr(s.labelKey)}
              </button>
            )
          })}
        </nav>
        <div className="rk-set-body" role="tabpanel">
          {tab === 'general' ? <SettingsView /> : null}
          {tab === 'models' ? <ModelSettingsPanel /> : null}
          {tab === 'connectors' ? <ConnectorsView /> : null}
          {tab === 'skills' ? <SkillsView /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * The models section: pick the default model. Same stores and the same
 * config.set call as the composer's picker; lib/model stays untouched.
 */
function ModelSettingsPanel() {
  const provs = useStore(providers)
  const current = useStore(currentModel)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useStore(locale)

  useEffect(() => { void refreshModels() }, [])

  const flat = useMemo(() => {
    const rows: { provider: string; providerName?: string; model: string; authenticated?: boolean }[] = []
    for (const p of provs) {
      for (const m of p.models) rows.push({ provider: p.slug, providerName: p.name, model: m.id, authenticated: p.authenticated })
    }
    const needle = q.trim().toLowerCase()
    return needle ? rows.filter((r) => r.model.toLowerCase().includes(needle) || r.provider.toLowerCase().includes(needle)) : rows
  }, [provs, q])

  const pick = async (provider: string, model: string) => {
    setBusy(`${provider}/${model}`)
    setErr('')
    try {
      await rpc('config.set', { key: 'model', value: `${model} --provider ${provider} --session` }, 20000)
      await refreshModels()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="focus">
      <div className="focus-head">
        <Cpu size={16} color="var(--accent)" />
        <span style={{ fontWeight: 650, fontSize: 15 }}>{tr('settings.nav.models')}</span>
        <div style={{ flex: 1 }} />
        {current.model ? (
          <span className="text-faint" style={{ fontSize: 12 }}>
            {tr('settings.model.current')}: {current.provider ? `${current.provider} · ` : ''}{current.model}
          </span>
        ) : null}
      </div>
      <div className="focus-body">
        <div style={{ maxWidth: 640, width: '100%', margin: '0 auto', padding: '16px 24px 40px' }}>
          <input className="input" placeholder={tr('chat.model.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="text-faint" style={{ fontSize: 'var(--text-xs)', margin: '8px 0 4px' }}>{tr('settings.model.hint')}</div>
          <div>
            {flat.map((r) => {
              const on = current.provider === r.provider && current.model === r.model
              return (
                <button
                  key={`${r.provider}/${r.model}`}
                  className={`row${on ? ' active' : ''}`}
                  onClick={() => void pick(r.provider, r.model)}
                  disabled={!!busy}
                >
                  {on ? <Check size={13} color="var(--accent)" /> : null}
                  <span className="row-title">{r.model}</span>
                  <span className="row-sub">{r.providerName ?? r.provider}{r.authenticated === false ? ` · ${tr('chat.model.needskey')}` : ''}</span>
                  {busy === `${r.provider}/${r.model}` ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
                </button>
              )
            })}
            {flat.length === 0 ? (
              <div style={{ padding: 14, color: 'var(--text-faint)', fontSize: 13 }}>{tr('chat.model.none')}</div>
            ) : null}
          </div>
          {err ? <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div> : null}
        </div>
      </div>
    </main>
  )
}
