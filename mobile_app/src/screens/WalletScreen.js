/**
 * The wallet.
 *
 * Balance first, ledger second. A traveller checking this screen is almost
 * always answering "can I afford what I am about to book?", so the balance is a
 * large single number at the top and the deposit button is reachable without
 * scrolling. The ledger is below for reconciliation, not for browsing.
 *
 * Balances are rendered from the server only. The client never keeps a cached
 * balance, because a stale figure that looks authoritative is worse than no
 * figure: `pay_booking` debits atomically on the server, so the screen refetches
 * after every action rather than optimistically decrementing a local copy.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../context/AuthContext';
import { wallet as walletApi } from '../api/endpoints';
import {
  Button, Callout, Card, DataRow, Divider, EmptyState, Input, Row, Skeleton,
} from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { dateTime, money, relativeTime } from '../utils/format';
import { describeError, errorLine } from '../utils/errors';

/** Quick top-up amounts. The custom field is there for everything else. */
const PRESETS = [500, 1000, 2500, 5000];

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [depositOpen, setDepositOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const result = await walletApi.get(token);
        setWallet(result?.wallet || null);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load({ quiet: true });
    }, [load]),
  );

  const deposit = useCallback(async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setDepositError('Enter an amount greater than zero.');
      return;
    }
    setDepositing(true);
    setDepositError(null);
    try {
      await walletApi.deposit(token, value);
      setAmount('');
      setDepositOpen(false);
      await load({ quiet: true });
    } catch (e) {
      setDepositError(describeError(e)?.message || errorLine(e));
    } finally {
      setDepositing(false);
    }
  }, [amount, token, load]);

  const balance = wallet?.balance;
  const transactions = [...(wallet?.transactions || [])].reverse();

  if (loading) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top + space.lg, paddingHorizontal: space.lg }]}>
        <Skeleton height={140} style={styles.gap} />
        <Skeleton height={200} />
      </View>
    );
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxxl }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => load({ quiet: true })} />
        }
      >
        {/* ------------------------------------------------------ balance */}
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>TripMind wallet</Text>
          <Text style={styles.balance} testID="wallet-balance">
            {money(balance)}
          </Text>
          {wallet?.updatedAt ? (
            <Text style={styles.balanceMeta}>Updated {relativeTime(wallet.updatedAt)}</Text>
          ) : null}
        </View>

        {error ? (
          <Callout
            tone={error.tone || 'danger'}
            message={error.message}
            action={error.action === 'Retry' ? 'Try again' : undefined}
            onAction={error.action === 'Retry' ? () => load() : undefined}
          />
        ) : null}

        <Button
          label="Add money"
          icon="＋"
          size="lg"
          onPress={() => setDepositOpen(true)}
          testID="open-deposit"
        />

        {wallet?.totalDeposited || wallet?.totalSpent ? (
          <Card style={styles.totalsCard}>
            <DataRow label="Total added" value={money(wallet.totalDeposited)} />
            <DataRow label="Total spent" value={money(wallet.totalSpent)} />
          </Card>
        ) : null}

        {/* ------------------------------------------------------- ledger */}
        <Text style={styles.sectionTitle}>Activity</Text>

        {!transactions.length ? (
          <EmptyState
            icon="💳"
            title="No transactions yet"
            message="Deposits and booking payments appear here so you can reconcile every rupee."
            compact
          />
        ) : (
          <Card style={styles.ledgerCard}>
            {transactions.map((txn, index) => (
              <LedgerRow
                key={txn.id || index}
                txn={txn}
                last={index === transactions.length - 1}
              />
            ))}
          </Card>
        )}

        <Text style={styles.footnote}>
          Payments are debited when you confirm a booking, using the same ledger for every
          client. TripMind never stores card details.
        </Text>
      </ScrollView>

      <DepositSheet
        visible={depositOpen}
        amount={amount}
        onChangeAmount={setAmount}
        onClose={() => {
          setDepositOpen(false);
          setDepositError(null);
        }}
        onSubmit={deposit}
        loading={depositing}
        error={depositError}
      />
    </View>
  );
}

function LedgerRow({ txn, last }) {
  const isCredit = String(txn.type || '').toUpperCase() === 'DEPOSIT';
  // The server stores debits as a negative amount, so the sign is the source of
  // truth; deriving it from the label alone would double-negate.
  const value = Number(txn.amount);
  const positive = isCredit || (Number.isFinite(value) && value >= 0);

  return (
    <View style={[styles.txn, !last && styles.txnBorder]}>
      <View style={[styles.txnIcon, isCredit ? styles.txnIconIn : styles.txnIconOut]}>
        <Text style={styles.txnGlyph}>{isCredit ? '↓' : '↑'}</Text>
      </View>
      <View style={styles.txnText}>
        <Text style={styles.txnDesc}>{txn.description || (isCredit ? 'Deposit' : 'Payment')}</Text>
        <Text style={styles.txnMeta}>
          {dateTime(txn.createdAt)}
          {txn.balance !== null && txn.balance !== undefined
            ? ` · balance ${money(txn.balance)}`
            : ''}
        </Text>
      </View>
      <Text
        style={[styles.txnAmount, { color: positive ? colors.success : colors.ink }]}
      >
        {positive ? '+' : ''}
        {money(Math.abs(value))}
      </Text>
    </View>
  );
}

/**
 * Deposit sheet.
 *
 * A modal rather than a screen because topping up is a short, interruptible
 * task the user returns from, not a destination.
 */
function DepositSheet({ visible, amount, onChangeAmount, onClose, onSubmit, loading, error }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetDismiss} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Add money</Text>

          <Input
            label="Amount"
            value={amount}
            onChangeText={(v) => onChangeAmount(v.replace(/[^0-9.]/g, ''))}
            placeholder="1000"
            keyboardType="numeric"
            testID="deposit-amount"
          />

          <Row gap={space.sm} style={styles.presetRow}>
            {PRESETS.map((preset) => (
              <Pressable
                key={preset}
                onPress={() => onChangeAmount(String(preset))}
                accessibilityRole="button"
                accessibilityLabel={`Add ${preset} rupees`}
                style={styles.preset}
              >
                <Text style={styles.presetLabel}>{money(preset, { compact: true })}</Text>
              </Pressable>
            ))}
          </Row>

          {error ? <Text style={styles.sheetError}>{error}</Text> : null}

          <Divider style={styles.sheetDivider} />

          <Button
            label={amount ? `Add ${money(amount)}` : 'Add money'}
            onPress={onSubmit}
            loading={loading}
            size="lg"
          />
          <Button label="Cancel" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.ink04 },
  content: { paddingHorizontal: space.lg, paddingTop: space.md },
  gap: { marginBottom: space.md },

  balanceCard: {
    backgroundColor: colors.brand800,
    borderRadius: radius.lg,
    padding: space.xl,
    marginBottom: space.lg,
  },
  balanceLabel: { ...type.small, color: colors.brand300 },
  balance: { fontSize: 38, lineHeight: 46, fontWeight: '800', color: colors.white, marginTop: 2 },
  balanceMeta: { ...type.caption, color: colors.brand300, marginTop: space.xs },

  totalsCard: { marginTop: space.md },

  sectionTitle: { ...type.heading, marginTop: space.xl, marginBottom: space.md },

  ledgerCard: { paddingVertical: space.sm },
  txn: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  txnBorder: { borderBottomWidth: 1, borderBottomColor: colors.ink08 },
  txnIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  txnIconIn: { backgroundColor: colors.successBg },
  txnIconOut: { backgroundColor: colors.ink08 },
  txnGlyph: { fontSize: 16, fontWeight: '700', color: colors.ink },
  txnText: { flex: 1 },
  txnDesc: { ...type.bodyStrong },
  txnMeta: { ...type.caption, marginTop: 2 },
  txnAmount: { ...type.bodyStrong },

  footnote: { ...type.caption, lineHeight: 18, marginTop: space.lg },

  sheetBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheetDismiss: { flex: 1 },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: space.xl,
    paddingBottom: space.xxxl,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.ink15,
    alignSelf: 'center',
    marginBottom: space.lg,
  },
  sheetTitle: { ...type.title, marginBottom: space.lg },
  sheetError: { ...type.caption, color: colors.danger, marginBottom: space.md },
  sheetDivider: { marginBottom: space.md },

  presetRow: { marginBottom: space.lg },
  preset: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brand50,
    borderWidth: 1,
    borderColor: colors.brand100,
  },
  presetLabel: { ...type.small, fontWeight: '700', color: colors.brand700 },
});
