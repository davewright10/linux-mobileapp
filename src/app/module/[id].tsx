import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { Card, Pill, styles } from '@/components/ui';
import { getModule, isReady } from '@/content';
import { learnedCount, useProgress } from '@/lib/progress';
import { colors } from '@/lib/theme';

export default function ModuleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const m = getModule(id);
  const { progress, dueCards } = useProgress();
  if (!m) return null;
  const best = progress.quizBest[m.id];
  const due = dueCards(m.id, m.cards.length).length;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: m.id }} />
      <Text style={styles.h1}>{m.title}</Text>
      <Text style={styles.muted}>{m.courseRef}</Text>
      <Text style={styles.body}>{m.summary}</Text>

      {!isReady(m) ? (
        <Card>
          <Text style={styles.h3}>Content coming soon</Text>
          <Text style={styles.muted}>
            Quizzes, flashcards and labs for this module are being written. You can still practise in the terminal or ask the tutor about this topic.
          </Text>
        </Card>
      ) : (
        <>
          <Card onPress={() => router.push(`/quiz/${m.id}`)}>
            <View style={styles.row}>
              <Text style={[styles.h2, { flex: 1 }]}>Quiz</Text>
              {best && <Pill text={`Best ${best.score}/${best.total}`} color={best.score / best.total >= 0.8 ? colors.green : colors.yellow} />}
            </View>
            <Text style={styles.muted}>{m.quiz.length} questions, each with a short explanation.</Text>
          </Card>
          <Card onPress={() => router.push(`/cards/${m.id}`)}>
            <View style={styles.row}>
              <Text style={[styles.h2, { flex: 1 }]}>Flashcards</Text>
              {due > 0 && <Pill text={`${due} due`} color={colors.blue} />}
            </View>
            <Text style={styles.muted}>
              {m.cards.length} cards · {learnedCount(progress, m.id)} learned. Cards you know come back less often.
            </Text>
          </Card>
          {m.labs.map((lab) => (
            <Card key={lab.id} onPress={() => router.push({ pathname: '/terminal', params: { lab: lab.id } })}>
              <View style={styles.row}>
                <Text style={[styles.h2, { flex: 1 }]}>Lab: {lab.title}</Text>
                {progress.labsDone[lab.id] && <Pill text="Done" color={colors.green} />}
              </View>
              <Text style={styles.muted}>{lab.intro}</Text>
            </Card>
          ))}
        </>
      )}

      <Card onPress={() => router.push({ pathname: '/tutor', params: { module: m.id } })}>
        <Text style={styles.h3}>Ask the tutor about {m.title.toLowerCase()}</Text>
      </Card>
    </ScrollView>
  );
}
