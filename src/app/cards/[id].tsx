import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Button, ProgressBar, styles } from '@/components/ui';
import { getModule } from '@/content';
import { useProgress } from '@/lib/progress';
import { colors, mono, space } from '@/lib/theme';

export default function CardsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const m = getModule(id);
  const { dueCards, recordCard } = useProgress();
  const [studyAll, setStudyAll] = useState(false);
  // Pick the deck once per session so cards don't vanish mid-review as they are answered.
  const deck = useMemo(() => {
    if (!m) return [];
    const due = dueCards(m.id, m.cards.length);
    return studyAll || !due.length ? m.cards.map((_, i) => i) : due;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, studyAll]);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState(0);

  if (!m) return null;

  if (pos >= deck.length) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: `${m.id} flashcards` }} />
        <Text style={styles.h1}>Session done</Text>
        <Text style={styles.body}>
          You knew {known} of {deck.length}. Cards you knew come back in a few days, and the rest come back next time.
        </Text>
        <Button
          title="Study all cards again"
          onPress={() => {
            setStudyAll(true);
            setPos(0);
            setKnown(0);
            setFlipped(false);
          }}
        />
      </ScrollView>
    );
  }

  const card = m.cards[deck[pos]];
  const answer = (knew: boolean) => {
    recordCard(m.id, deck[pos], knew);
    if (knew) setKnown((k) => k + 1);
    setFlipped(false);
    setPos((p) => p + 1);
  };

  return (
    <View style={[styles.screen, { padding: space(4), gap: space(3) }]}>
      <Stack.Screen options={{ title: `${m.id} flashcards` }} />
      <ProgressBar value={pos / deck.length} />
      <Text style={styles.muted}>
        Card {pos + 1} of {deck.length} · tap the card to flip
      </Text>
      <Pressable
        onPress={() => setFlipped((f) => !f)}
        style={[styles.card, { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space(6), borderColor: flipped ? colors.blue : colors.border }]}
      >
        <Text style={[styles.muted, { position: 'absolute', top: space(4) }]}>{flipped ? 'Answer' : 'Question'}</Text>
        <Text
          style={[
            flipped ? styles.body : styles.h2,
            { textAlign: 'center', fontSize: flipped ? 18 : 24, lineHeight: flipped ? 27 : 32 },
            !flipped && /^[a-z/~.-]/.test(card.front) && { fontFamily: mono },
          ]}
        >
          {flipped ? card.back : card.front}
        </Text>
      </Pressable>
      {flipped ? (
        <View style={[styles.row, { gap: space(3) }]}>
          <Button title="Again" kind="bad" style={{ flex: 1 }} onPress={() => answer(false)} />
          <Button title="Got it" kind="good" style={{ flex: 1 }} onPress={() => answer(true)} />
        </View>
      ) : (
        <Button title="Show answer" onPress={() => setFlipped(true)} />
      )}
    </View>
  );
}
