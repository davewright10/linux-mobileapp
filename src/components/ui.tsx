import { ReactNode } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { colors, mono, space } from '@/lib/theme';

export function Card({ children, onPress, style, disabled }: { children: ReactNode; onPress?: () => void; style?: StyleProp<ViewStyle>; disabled?: boolean }) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.cardPressed }, disabled && { opacity: 0.45 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled, style }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'good' | 'bad'; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  const bg = kind === 'primary' ? colors.accent : kind === 'good' ? colors.green : kind === 'bad' ? '#b62324' : colors.card;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }, kind === 'secondary' && styles.secondary, style]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }]} />
    </View>
  );
}

export function Pill({ text, color = colors.muted }: { text: string; color?: string }) {
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{text}</Text>
    </View>
  );
}

/** Renders the small subset of Markdown the tutor uses: **bold**, `code`, ```blocks``` and _italics_. */
export function RichText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const blocks = text.split(/```(?:\w+)?\n?/);
  return (
    <View style={{ gap: space(2) }}>
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.codeBlock} selectable>
            {block.replace(/\n$/, '')}
          </Text>
        ) : block.trim() ? (
          <Text key={i} style={[styles.body, style]} selectable>
            {inline(block.trim())}
          </Text>
        ) : null,
      )}
    </View>
  );
}

function inline(s: string): ReactNode[] {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <Text key={i} style={{ fontWeight: '700' }}>{p.slice(2, -2)}</Text>;
    if (p.startsWith('`') && p.endsWith('`')) return <Text key={i} style={styles.codeInline}>{p.slice(1, -1)}</Text>;
    if (p.startsWith('_') && p.endsWith('_') && p.length > 2) return <Text key={i} style={{ fontStyle: 'italic', color: colors.muted }}>{p.slice(1, -1)}</Text>;
    return p;
  });
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space(4), gap: space(3), paddingBottom: space(10) },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: space(4), borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: space(1.5) },
  h1: { color: colors.text, fontSize: 28, fontWeight: '800' },
  h2: { color: colors.text, fontSize: 19, fontWeight: '700' },
  h3: { color: colors.text, fontSize: 16, fontWeight: '600' },
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  button: { paddingVertical: space(3.5), paddingHorizontal: space(4), borderRadius: 12, alignItems: 'center' },
  secondary: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  barTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.green, borderRadius: 3 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: space(2), paddingVertical: 2 },
  pillText: { fontSize: 12, fontWeight: '600' },
  codeBlock: { fontFamily: mono, fontSize: 13, color: colors.terminalText, backgroundColor: colors.terminalBg, padding: space(3), borderRadius: 8 },
  codeInline: { fontFamily: mono, fontSize: 14, color: '#ffa198' },
});
