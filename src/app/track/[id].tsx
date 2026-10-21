import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { Card, Pill, styles } from '@/components/ui';
import { TrackId, getTrack, isReady, modulesFor } from '@/content';
import { learnedCount, useProgress } from '@/lib/progress';
import { colors } from '@/lib/theme';

export default function TrackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const track = getTrack(id);
  const { progress } = useProgress();
  if (!track) return null;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: track.title }} />
      <Text style={styles.muted}>{track.course}</Text>
      {modulesFor(track.id as TrackId).map((m) => {
        const ready = isReady(m);
        const best = progress.quizBest[m.id];
        const passed = best && best.score / best.total >= 0.8;
        return (
          <Card key={m.id} onPress={() => router.push(`/module/${m.id}`)} style={!ready && { opacity: 0.55 }}>
            <View style={styles.row}>
              <Text style={[styles.muted, { fontWeight: '700', width: 34 }]}>{m.id}</Text>
              <Text style={[styles.h3, { flex: 1 }]}>{m.title}</Text>
              {passed ? <Pill text="Passed" color={colors.green} /> : !ready ? <Pill text="Coming soon" /> : null}
            </View>
            <Text style={styles.muted}>{m.courseRef}</Text>
            {ready && (
              <Text style={styles.muted}>
                Quiz {best ? `${best.score}/${best.total}` : 'not taken'} · Cards {learnedCount(progress, m.id)}/{m.cards.length} learned · Labs{' '}
                {m.labs.filter((l) => progress.labsDone[l.id]).length}/{m.labs.length}
              </Text>
            )}
          </Card>
        );
      })}
    </ScrollView>
  );
}
