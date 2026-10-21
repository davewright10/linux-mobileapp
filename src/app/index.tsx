import { router } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { Card, Pill, ProgressBar, styles } from '@/components/ui';
import { TRACKS, isReady, modulesFor } from '@/content';
import { useProgress } from '@/lib/progress';
import { colors } from '@/lib/theme';

export default function Home() {
  const { progress } = useProgress();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.muted}>Practise what you learn in the course, anywhere.</Text>

      {TRACKS.map((t) => {
        const mods = modulesFor(t.id);
        const ready = mods.filter(isReady);
        const done = ready.filter((m) => {
          const best = progress.quizBest[m.id];
          return best && best.score / best.total >= 0.8;
        }).length;
        return (
          <Card key={t.id} onPress={() => router.push(`/track/${t.id}`)}>
            <View style={styles.row}>
              <Text style={[styles.h2, { flex: 1 }]}>{t.title}</Text>
              <Pill text={`${mods.length} modules`} />
            </View>
            <Text style={styles.body}>{t.subtitle}</Text>
            <Text style={styles.muted}>{t.course}</Text>
            <ProgressBar value={ready.length ? done / ready.length : 0} />
            <Text style={styles.muted}>
              {done} of {ready.length} available modules passed
            </Text>
          </Card>
        );
      })}

      <Card onPress={() => router.push('/terminal')}>
        <Text style={styles.h2}>
          <Text style={{ color: colors.green }}>$</Text> Practice terminal
        </Text>
        <Text style={styles.muted}>A simulated RHEL 10 server that works offline. Try any command.</Text>
      </Card>

      <Card onPress={() => router.push('/tutor')}>
        <Text style={styles.h2}>Ask the tutor</Text>
        <Text style={styles.muted}>Stuck on something? Ask in plain words and get a simple explanation.</Text>
      </Card>
    </ScrollView>
  );
}
