import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, FlatList, StyleSheet, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import { useRouter } from 'expo-router'
import {
  createProfile,
  fleetError,
  fleetProfiles,
  fleetStatusAtom,
  freezeProfile,
  refreshFleet,
  slugifyName,
  soulDraft,
  FleetProfile,
} from '../../src/lib/fleet'
import { isConnected } from '../../src/lib/gateway'
import { tr, isRTL } from '../../src/lib/strings'

/** §2.7 starter templates: tappable job seeds — zero typing path. */
const STARTERS: { label: string; job: string }[] = [
  { label: 'Research', job: 'Research assistant: read my saved sources daily and brief me on what changed.' },
  { label: 'Deals', job: 'Deal watcher: track product pages I name and notify me on price drops.' },
  { label: 'Code (PC)', job: 'Code helper bound to my linked PC: work in my repos on request.' },
  { label: 'Private journal', job: 'Private journal/finance watcher over my own local files only — never sends anything anywhere.' },
]

/**
 * Fleet (M9.2): the bots surface. Feature-detected (B12): with no profiles the
 * screen is a friendly entry point; the chat experience never changes. Runtime
 * status (queue/waiting) renders only when the gateway runs the fleet runtime.
 */
export default function Fleet() {
  const s = useStyles(makeS)
  const router = useRouter()
  const online = useStore(isConnected)
  const profiles = useStore(fleetProfiles)
  const status = useStore(fleetStatusAtom)
  const error = useStore(fleetError)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!online) return
    void refreshFleet().finally(() => setLoading(false))
  }, [online])

  useEffect(refresh, [refresh])

  const frozenSet = new Set((status?.profiles ?? []).filter((p) => p.frozen).map((p) => p.name))

  const create = async () => {
    if (!job.trim() || busy) return
    setBusy('create')
    try {
      const name = slugifyName(job)
      await createProfile({ name, description: job.trim(), soul: soulDraft(job, name) })
      setJob('')
      setCreating(false)
    } finally {
      setBusy(null)
    }
  }

  const toggleFreeze = async (pf: FleetProfile) => {
    if (busy) return
    setBusy(pf.name)
    try {
      await freezeProfile(pf.name, !frozenSet.has(pf.name))
    } finally {
      setBusy(null)
    }
  }

  const waiting = status?.queue.waiting ?? []

  return (
    <SafeAreaView style={s.safe} edges={['bottom']}>
      <ScreenShell
        title={tr("fleet.title")}
        showBrand
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr('fleet.refresh')}
            onPress={refresh}
            hitSlop={8}
          >
            <Ionicons name="refresh" size={22} color={C.textDim} />
          </Pressable>
        }
      >
        {error ? <Text style={s.banner}>{tr("fleet.offline")}: {error}</Text> : null}
        {status ? (
          <View style={s.statusRow}>
            <Text style={s.statusText}>
              {status.fleetEnabled
                ? tr('fleet.runtime.active', { active: status.queue.active, slots: status.queue.slots })
                : tr('fleet.runtime.idle')}
            </Text>
            {waiting.length > 0 ? (
              <Text style={s.statusText}>
                {tr('fleet.waiting', { n: waiting.length, prios: waiting.map((w) => w.priority).join(', ') })}
              </Text>
            ) : null}
          </View>
        ) : null}

        {loading && online ? (
          <ActivityIndicator style={s.spin} />
        ) : (
          <FlatList
            data={profiles}
            keyExtractor={(item) => item.name}
            ListEmptyComponent={
              <View style={s.empty}>
                <Ionicons name="people-outline" size={40} color={C.textDim} />
                <Text style={s.emptyTitle}>{tr("fleet.empty.title")}</Text>
                <Text style={s.emptyBody}>{tr("fleet.empty.body")}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const frozen = frozenSet.has(item.name)
              return (
                <Pressable
                  style={s.card}
                  onPress={() => router.push({ pathname: '/bot', params: { name: item.name } } as never)}
                >
                  <View style={s.cardHead}>
                    <Ionicons
                      name={frozen ? 'snow-outline' : 'person-circle-outline'}
                      size={26}
                      color={frozen ? C.accent : C.textDim}
                    />
                    <View style={s.cardTitles}>
                      <Text style={s.cardName}>{item.name}</Text>
                      {!!item.description && (
                        <Text style={s.cardDesc} numberOfLines={2}>
                          {item.description}
                        </Text>
                      )}
                    </View>
                    <Pressable
                      accessibilityLabel={tr("fleet.chat", { name: item.name })}
                      onPress={() => router.navigate({
                        pathname: '/(tabs)/chat',
                        params: { botProfile: item.name },
                      } as never)}
                      style={s.freezeBtn}
                      hitSlop={6}
                    >
                      <Ionicons name="chatbubble-outline" size={18} color={C.textDim} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={frozen ? tr("fleet.unfreeze", { name: item.name }) : tr("fleet.freeze", { name: item.name })}
                      onPress={() => toggleFreeze(item)}
                      disabled={busy === item.name}
                      style={s.freezeBtn}
                      hitSlop={6}
                    >
                      {busy === item.name ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Ionicons
                          name={frozen ? 'play-outline' : 'pause-outline'}
                          size={20}
                          color={C.textDim}
                        />
                      )}
                    </Pressable>
                  </View>
                </Pressable>
              )
            }}
          />
        )}

        <View style={s.createWrap}>
          {creating ? (
            <View style={s.createBox}>
              <View style={[s.chips, isRTL() && { flexDirection: 'row-reverse' }]}>
                {STARTERS.map((st) => (
                  <Pressable
                    key={st.label}
                    style={[s.chip, job === st.job && s.chipActive]}
                    onPress={() => setJob(st.job)}
                  >
                    <Text style={s.chipText}>{st.label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={s.input}
                placeholder={tr("fleet.create.job")}
                placeholderTextColor={C.textDim}
                value={job}
                onChangeText={setJob}
                multiline
                autoFocus
              />
              <Text style={s.hint}>{tr("fleet.create.suggested")}: {slugifyName(job) || "…"}</Text>
              <View style={s.rowBtns}>
                <Pressable style={s.btnGhost} onPress={() => setCreating(false)}>
                  <Text style={s.btnGhostText}>{tr("fleet.cancel")}</Text>
                </Pressable>
                <Pressable
                  style={[s.btn, !job.trim() && s.btnDisabled]}
                  onPress={create}
                  disabled={!job.trim() || busy === 'create'}
                >
                  {busy === 'create' ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Text style={s.btnText}>{tr("fleet.create.cta")}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable accessibilityRole="button" style={s.fab} onPress={() => setCreating(true)} disabled={!online}>
              <Ionicons name="add" size={20} color={C.bg} />
              <Text style={s.fabText}>{tr("fleet.create")}</Text>
            </Pressable>
          )}
        </View>
      </ScreenShell>
    </SafeAreaView>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    banner: { color: C.red, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
    statusRow: { paddingHorizontal: 16, paddingBottom: 6 },
    statusText: { color: C.textDim, fontSize: 12 },
    spin: { marginTop: 24 },
    empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 48 },
    emptyTitle: { color: C.text, fontSize: 18, fontWeight: '600', marginTop: 12 },
    emptyBody: { color: C.textDim, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
    card: {
      backgroundColor: C.bgCard,
      borderRadius: 14,
      marginHorizontal: 16,
      marginTop: 10,
      padding: 14,
    },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cardTitles: { flex: 1 },
    cardName: { color: C.text, fontSize: 15, fontWeight: '600' },
    cardDesc: { color: C.textDim, fontSize: 12, marginTop: 2 },
    freezeBtn: { padding: 6 },
    createWrap: { padding: 16 },
    chips: { flexDirection: isRTL() ? 'row-reverse' : 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    chip: { borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10, paddingVertical: 5 },
    chipActive: { backgroundColor: C.accentSoft, borderColor: C.accent },
    chipText: { color: C.textDim, fontSize: 11 },
    createBox: {
      backgroundColor: C.bgCard,
      borderRadius: 14,
      padding: 12,
    },
    input: {
      color: C.text,
      minHeight: 60,
      fontSize: 14,
      textAlignVertical: 'top',
      padding: 8,
      borderRadius: 8,
      backgroundColor: C.bg,
    },
    hint: { color: C.textDim, fontSize: 11, marginTop: 6 },
    rowBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
    btn: {
      backgroundColor: C.accent,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: C.bg, fontWeight: '600', fontSize: 13 },
    btnGhost: { paddingHorizontal: 12, paddingVertical: 9 },
    btnGhostText: { color: C.textDim, fontSize: 13 },
    fab: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: C.accent,
      borderRadius: 12,
      paddingVertical: 12,
    },
    fabText: { color: C.bg, fontWeight: '700' },
  })
