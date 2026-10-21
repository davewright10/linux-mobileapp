import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Button, Card, ProgressBar, styles } from '@/components/ui';
import { getModule } from '@/content';
import { useProgress } from '@/lib/progress';
import { colors, space } from '@/lib/theme';

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function QuizScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const m = getModule(id);
  const { recordQuiz } = useProgress();
  const [questions, setQuestions] = useState(() => shuffle(m?.quiz ?? []));
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [missed, setMissed] = useState<string[]>([]);

  if (!m) return null;
  const done = index >= questions.length;

  if (done) {
    const pct = questions.length ? score / questions.length : 0;
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: `${m.id} quiz` }} />
        <Text style={styles.h1}>
          {score} / {questions.length}
        </Text>
        <Text style={styles.body}>
          {pct >= 0.8 ? 'Nice work. This module counts as passed.' : 'Keep going. Review the flashcards, then try again. 80% passes the module.'}
        </Text>
        {missed.length > 0 && (
          <Card>
            <Text style={styles.h3}>Worth another look</Text>
            {missed.map((q) => (
              <Text key={q} style={styles.muted}>
                • {q}
              </Text>
            ))}
          </Card>
        )}
        <Button
          title="Try again"
          onPress={() => {
            setQuestions(shuffle(m.quiz));
            setIndex(0);
            setScore(0);
            setMissed([]);
            setPicked(null);
          }}
        />
        <Button title="Flashcards" kind="secondary" onPress={() => router.replace(`/cards/${m.id}`)} />
      </ScrollView>
    );
  }

  const q = questions[index];
  const answered = picked !== null;
  const choose = (i: number) => {
    if (answered) return;
    setPicked(i);
    if (i === q.answer) setScore((s) => s + 1);
    else setMissed((list) => [...list, q.q]);
  };
  const next = () => {
    const last = index + 1 >= questions.length;
    if (last) recordQuiz(m.id, score, questions.length);
    setPicked(null);
    setIndex((i) => i + 1);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: `${m.id} quiz` }} />
      <ProgressBar value={index / questions.length} />
      <Text style={styles.muted}>
        Question {index + 1} of {questions.length}
      </Text>
      <Text style={styles.h2}>{q.q}</Text>
      <View style={{ gap: space(2) }}>
        {q.choices.map((c, i) => {
          const isRight = answered && i === q.answer;
          const isWrong = answered && i === picked && i !== q.answer;
          return (
            <Pressable
              key={i}
              onPress={() => choose(i)}
              style={({ pressed }) => [
                styles.card,
                pressed && !answered && { backgroundColor: colors.cardPressed },
                isRight && { borderColor: colors.green, backgroundColor: colors.greenSoft },
                isWrong && { borderColor: colors.accent, backgroundColor: colors.accentSoft },
              ]}
            >
              <Text style={styles.body}>{c}</Text>
            </Pressable>
          );
        })}
      </View>
      {answered && (
        <>
          <Card>
            <Text style={[styles.h3, { color: picked === q.answer ? colors.green : colors.accent }]}>
              {picked === q.answer ? 'Correct' : 'Not quite'}
            </Text>
            <Text style={styles.body}>{q.why}</Text>
          </Card>
          <Button title={index + 1 >= questions.length ? 'See results' : 'Next'} onPress={next} />
          <Button
            title="Ask the tutor about this"
            kind="secondary"
            onPress={() => router.push({ pathname: '/tutor', params: { module: m.id, ask: `Can you explain this quiz question more simply? "${q.q}" The answer is "${q.choices[q.answer]}".` } })}
          />
        </>
      )}
    </ScrollView>
  );
}
