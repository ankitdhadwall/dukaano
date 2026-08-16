import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { SafeAreaView, StyleSheet, Text, View } from 'react-native'
import { formatMoney, translate } from '@dukaano/i18n'
import { asPaise } from '@dukaano/money'
import { database } from './src/data/expo-sqlite'
import { pendingCount } from './src/data/outbox'
import { remainingLeaseNumbers, todayTotals } from './src/data/sales.repository'

/**
 * A boot check, not the app.
 *
 * The screens are the next piece of work. What this proves — and it is worth proving before
 * building on top of it — is that the whole stack wires together on a device: expo-sqlite opens,
 * the migration runs, the shared `@dukaano/money` and `@dukaano/i18n` packages resolve inside the
 * Metro bundler, and Devanagari renders.
 *
 * The last one is not a formality. A Hindi-first app whose fonts fall back to boxes is unusable
 * for the people it was built for, and that failure only ever shows up on a real screen.
 */
export default function App() {
  const [status, setStatus] = useState<'opening' | 'ready' | 'failed'>('opening')
  const [error, setError] = useState<string | null>(null)
  const [totals, setTotals] = useState({ saleCount: 0, totalPaise: 0, creditPaise: 0, cashPaise: 0 })
  const [queued, setQueued] = useState(0)
  const [numbersLeft, setNumbersLeft] = useState(0)

  useEffect(() => {
    try {
      const db = database()
      const today = new Date().toISOString().slice(0, 10)
      setTotals(todayTotals(db, today))
      setQueued(pendingCount(db))
      setNumbersLeft(remainingLeaseNumbers(db))
      setStatus('ready')
    } catch (cause) {
      // Shown, never swallowed. A database that failed to open must not present as an empty shop.
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus('failed')
    }
  }, [])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.brand}>{translate('hi', 'common.appName')}</Text>
        <Text style={styles.tagline}>{translate('hi', 'common.tagline')}</Text>
      </View>

      {status === 'failed' ? (
        <View style={styles.card}>
          <Text style={styles.errorTitle}>{translate('hi', 'errors.unknown')}</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>{translate('hi', 'nav.home')}</Text>

          <Row label={translate('hi', 'common.total')} value={formatMoney(asPaise(totals.totalPaise), 'hi')} />
          <Row label={translate('hi', 'sale.udhaar')} value={formatMoney(asPaise(totals.creditPaise), 'hi')} />
          <Row label={translate('hi', 'sale.cash')} value={formatMoney(asPaise(totals.cashPaise), 'hi')} />

          <View style={styles.divider} />

          <Row
            label={translate('hi', 'sync.status.synced')}
            value={queued === 0 ? '✓' : translate('hi', 'sync.status.pending', { count: queued })}
          />
          <Row label="बिल नंबर बाकी" value={String(numbersLeft)} />

          <Text style={styles.note}>{translate('hi', 'sync.numbers.gapsAreNormal')}</Text>
        </View>
      )}
    </SafeAreaView>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0F1B2D' },
  header: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24 },
  brand: { color: '#FFFFFF', fontSize: 34, fontWeight: '700' },
  // Devanagari sits lower and taller than Latin; a line height tuned for Latin clips the
  // matras (§22). This is the first place that shows up.
  tagline: { color: '#8FA3BF', fontSize: 15, marginTop: 6, lineHeight: 24 },
  card: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 20,
  },
  label: { fontSize: 13, color: '#6B7A90', letterSpacing: 0.6, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  rowLabel: { fontSize: 17, color: '#1E2B3D', lineHeight: 26 },
  rowValue: { fontSize: 17, fontWeight: '600', color: '#0F1B2D', fontVariant: ['tabular-nums'] },
  divider: { height: 1, backgroundColor: '#E6EAF0', marginVertical: 12 },
  note: { fontSize: 13, color: '#6B7A90', marginTop: 14, lineHeight: 21 },
  errorTitle: { fontSize: 17, fontWeight: '600', color: '#B3261E', lineHeight: 26 },
  errorBody: { fontSize: 13, color: '#6B7A90', marginTop: 8 },
})
