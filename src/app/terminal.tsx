import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, ScrollViewInstance, Text, TextInput, TextInputInstance, View } from 'react-native';
import { styles as ui } from '@/components/ui';
import { getLab } from '@/content';
import { useProgress } from '@/lib/progress';
import { colors, mono, space } from '@/lib/theme';
import { complete } from '@/shell/complete';
import { Shell } from '@/shell/shell';

interface Line {
  text: string;
  cmd?: boolean;
}

const WELCOME = 'Red Hat Enterprise Linux 10.0 practice server (simulated).\nType "help" to see the commands you can use.\n';
const KEYS = ['Tab', '^C', '↑', '↓', '|', '/', '-', '~', '>', '*', '$', '&&', 'Clear'];
const MAX_LINES = 400;

export default function TerminalScreen() {
  const { lab: labId } = useLocalSearchParams<{ lab?: string }>();
  const found = labId ? getLab(labId) : undefined;
  const lab = found?.lab;
  const { recordLab, progress } = useProgress();

  const makeShell = useCallback(() => {
    const sh = new Shell();
    lab?.setup?.(sh);
    return sh;
  }, [lab]);

  // The Shell object holds the simulated system and is mutated in place by each command.
  const [shell, setShell] = useState(makeShell);
  const [lines, setLines] = useState<Line[]>([{ text: WELCOME }]);
  const [input, setInput] = useState('');
  const [prompt, setPrompt] = useState(() => shell.prompt());
  const [doneTasks, setDoneTasks] = useState<boolean[]>(() => lab?.tasks.map(() => false) ?? []);
  const [hint, setHint] = useState<number | null>(null);
  const [showLab, setShowLab] = useState(true);
  const historyPos = useRef<number | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const inputRef = useRef<TextInputInstance>(null);

  const current = doneTasks.findIndex((d) => !d);
  const allDone = !!lab && current === -1;

  useEffect(() => {
    if (allDone && lab && !progress.labsDone[lab.id]) recordLab(lab.id);
  }, [allDone, lab, progress.labsDone, recordLab]);

  const append = (more: Line[]) => setLines((prev) => [...prev, ...more].slice(-MAX_LINES));

  const submit = () => {
    const sh = shell;
    const cmd = input;
    const result = sh.run(cmd);
    const echo = { text: prompt + cmd, cmd: true };
    if (result.clear) setLines([]);
    else append(result.output ? [echo, { text: result.output.replace(/\n$/, '') }] : [echo]);
    setInput('');
    setPrompt(sh.prompt());
    historyPos.current = null;
    if (lab) setDoneTasks((prev) => prev.map((d, i) => d || lab.tasks[i].check(sh)));
    setHint(null);
  };

  const key = (k: string) => {
    const sh = shell;
    if (k === 'Tab') {
      const r = complete(sh, input);
      if (r.options.length > 1) append([{ text: prompt + input, cmd: true }, { text: r.options.join('  ') }]);
      setInput(r.line);
    } else if (k === '↑' || k === '↓') {
      const h = sh.history;
      if (!h.length) return;
      let pos = historyPos.current ?? h.length;
      pos = k === '↑' ? Math.max(0, pos - 1) : Math.min(h.length, pos + 1);
      historyPos.current = pos;
      setInput(h[pos] ?? '');
    } else if (k === '^C') {
      // Ctrl+C: throw away an unfinished multi-line command (the "> " prompt) or the line being typed
      append([{ text: prompt + input + '^C', cmd: true }]);
      sh.cancelInput();
      setInput('');
      setPrompt(sh.prompt());
      historyPos.current = null;
    } else if (k === 'Clear') {
      setInput('');
    } else {
      setInput((s) => s + (k === '&&' ? ' && ' : k === '|' || k === '>' ? ` ${k} ` : k));
    }
    inputRef.current?.focus();
  };

  const reset = () => {
    const fresh = makeShell();
    setShell(fresh);
    setLines([{ text: WELCOME }]);
    setPrompt(fresh.prompt());
    setDoneTasks(lab?.tasks.map(() => false) ?? []);
    setInput('');
  };

  const tutorContext = useMemo(() => {
    const recent = lines.slice(-12).map((l) => l.text).join('\n');
    const task = lab && current >= 0 ? `Lab "${lab.title}", current task: ${lab.tasks[current].text}\n` : '';
    return `${task}Recent practice terminal output:\n${recent}`;
  }, [lines, lab, current]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.terminalBg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <Stack.Screen
        options={{
          title: lab ? lab.title : 'Practice terminal',
          headerRight: () => (
            <View style={[ui.row, { gap: space(4) }]}>
              <Pressable onPress={() => router.push({ pathname: '/tutor', params: { context: tutorContext, module: found?.module.id ?? '' } })}>
                <Text style={{ color: colors.blue, fontSize: 16 }}>Ask</Text>
              </Pressable>
              <Pressable onPress={reset}>
                <Text style={{ color: colors.blue, fontSize: 16 }}>Reset</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      {lab && (
        <View style={{ backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border, padding: space(3), gap: space(1.5) }}>
          <Pressable onPress={() => setShowLab((s) => !s)} style={ui.row}>
            <Text style={[ui.h3, { flex: 1 }]}>
              {allDone ? 'Lab complete!' : `Task ${current + 1} of ${lab.tasks.length}`}
            </Text>
            <Text style={ui.muted}>{showLab ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {showLab &&
            lab.tasks.map((t, i) => (
              <View key={i} style={{ gap: 2 }}>
                <View style={[ui.row, { alignItems: 'flex-start' }]}>
                  <Text style={{ color: doneTasks[i] ? colors.green : i === current ? colors.text : colors.muted, width: 20 }}>{doneTasks[i] ? '✓' : `${i + 1}.`}</Text>
                  <Text style={[ui.muted, { flex: 1, color: doneTasks[i] ? colors.muted : i === current ? colors.text : colors.muted }]}>{t.text}</Text>
                  {i === current && (
                    <Pressable onPress={() => setHint(hint === i ? null : i)}>
                      <Text style={{ color: colors.blue }}>Hint</Text>
                    </Pressable>
                  )}
                </View>
                {hint === i && <Text style={{ fontFamily: mono, color: colors.yellow, marginLeft: 20, fontSize: 13 }}>{t.hint}</Text>}
              </View>
            ))}
        </View>
      )}

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space(3) }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => inputRef.current?.focus()}>
          {lines.map((l, i) => (
            <Text key={i} selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: l.cmd ? colors.text : colors.terminalText }}>
              {l.text}
            </Text>
          ))}
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontFamily: mono, fontSize: 13, color: colors.prompt }}>{prompt}</Text>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={submit}
              submitBehavior="submit"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
              returnKeyType="send"
              autoFocus
              style={{ flex: 1, fontFamily: mono, fontSize: 13, color: colors.text, padding: 0 }}
              placeholder="type a command"
              placeholderTextColor="#3a4450"
            />
          </View>
        </Pressable>
      </ScrollView>

      <ScrollView horizontal keyboardShouldPersistTaps="always" style={{ flexGrow: 0, backgroundColor: colors.card, borderTopWidth: 1, borderColor: colors.border }} contentContainerStyle={{ padding: space(1.5), gap: space(1.5) }}>
        {KEYS.map((k) => (
          <Pressable key={k} onPress={() => key(k)} style={({ pressed }) => ({ paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: 8, backgroundColor: pressed ? colors.border : colors.cardPressed })}>
            <Text style={{ color: colors.text, fontFamily: mono, fontSize: 15 }}>{k}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
