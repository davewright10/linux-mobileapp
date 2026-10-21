import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, ScrollViewInstance, Text, TextInput, View } from 'react-native';
import { RichText, styles as ui } from '@/components/ui';
import { getModule } from '@/content';
import { colors, space } from '@/lib/theme';
import { ChatMessage, askTutor, tutorOnline } from '@/lib/tutor';

const SUGGESTIONS = [
  'What is the difference between a hard link and a soft link?',
  'Explain chmod 750 like I am new to Linux',
  'What does SELinux actually do?',
  'How should I prepare for the RHCSA exam?',
];

export default function TutorScreen() {
  const params = useLocalSearchParams<{ module?: string; context?: string; ask?: string }>();
  const mod = params.module ? getModule(params.module) : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(params.ask ?? '');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);

  const context = [mod ? `The learner is studying module ${mod.id} "${mod.title}" (${mod.courseRef}).` : '', params.context ?? '']
    .filter(Boolean)
    .join('\n');

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setBusy(true);
    const reply = await askTutor(next, context || undefined);
    setMessages([...next, { role: 'assistant', content: reply }]);
    setBusy(false);
  };

  useEffect(() => {
    scroll.current?.scrollToEnd({ animated: true });
  }, [messages, busy]);

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <ScrollView ref={scroll} contentContainerStyle={[ui.content, { paddingBottom: space(4) }]} keyboardShouldPersistTaps="handled">
        {!messages.length && (
          <View style={{ gap: space(3) }}>
            <Text style={ui.body}>
              Ask anything about Linux or the RHCSA exam. I’ll explain it in plain language{mod ? `, with ${mod.title.toLowerCase()} in mind` : ''}.
            </Text>
            {!tutorOnline && (
              <Text style={ui.muted}>The AI tutor isn’t connected in this build yet, so answers come from the app’s flashcards for now.</Text>
            )}
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={({ pressed }) => [ui.card, pressed && { backgroundColor: colors.cardPressed }]}>
                <Text style={ui.body}>{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <View key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: colors.accent, borderRadius: 16, padding: space(3) }}>
              <Text style={[ui.body, { color: '#fff' }]}>{m.content}</Text>
            </View>
          ) : (
            <View key={i} style={[ui.card, { alignSelf: 'flex-start', maxWidth: '95%' }]}>
              <RichText text={m.content} />
            </View>
          ),
        )}
        {busy && <ActivityIndicator color={colors.muted} style={{ alignSelf: 'flex-start', margin: space(2) }} />}
      </ScrollView>
      <View style={[ui.row, { padding: space(3), borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.card }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask a question"
          placeholderTextColor={colors.muted}
          multiline
          style={{ flex: 1, color: colors.text, fontSize: 16, maxHeight: 120, paddingVertical: space(2) }}
        />
        <Pressable onPress={() => send(input)} disabled={busy || !input.trim()} style={{ opacity: busy || !input.trim() ? 0.4 : 1, padding: space(2) }}>
          <Text style={{ color: colors.blue, fontSize: 16, fontWeight: '700' }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
