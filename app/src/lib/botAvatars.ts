/**
 * Bot profile pictures (UI-009): the mochi-children set — Moch's little
 * helper faces. Static requires (Metro bundles exactly these); bots map to
 * one deterministically via botRoster's avatarIndex, so a bot keeps the same
 * face across launches, themes and surfaces.
 *
 * DELIBERATELY shaped like the proven mochi-run assets: 8-bit PNGs at the
 * assets ROOT, requires at component-visible module scope. The first cut
 * (16-bit PNGs in an assets/bots/ subdirectory, required from a lib file)
 * shipped blank on-device — root-level 8-bit is the pattern the app already
 * renders reliably (MOCHI_RUN, logo), so the set conforms to it.
 */
export const BOT_AVATARS: import('react-native').ImageSourcePropType[] = [
  require('../../assets/bot-face-01.png'),
  require('../../assets/bot-face-02.png'),
  require('../../assets/bot-face-03.png'),
  require('../../assets/bot-face-04.png'),
  require('../../assets/bot-face-05.png'),
  require('../../assets/bot-face-06.png'),
  require('../../assets/bot-face-07.png'),
  require('../../assets/bot-face-08.png'),
  require('../../assets/bot-face-09.png'),
  require('../../assets/bot-face-10.png'),
  require('../../assets/bot-face-11.png'),
  require('../../assets/bot-face-12.png'),
  require('../../assets/bot-face-13.png'),
  require('../../assets/bot-face-14.png'),
  require('../../assets/bot-face-15.png'),
]
