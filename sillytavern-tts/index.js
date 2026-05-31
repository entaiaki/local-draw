class Qwen3TTSProvider {
  constructor() {
    this.apiUrl = 'http://127.0.0.1:8080';
    this.voices = [];
    this.speakersUrl = '/api/draw/tts/speakers';
    this.generateUrl = '/v1/audio/speech';
    this.name = 'Qwen3-TTS';
    this.description = '本地 Qwen3-TTS 语音合成（预制音色）';
  }

  async getVoiceList() {
    try {
      const resp = await fetch(this.apiUrl + this.speakersUrl);
      const data = await resp.json();
      this.voices = (data.speakers || []).map(s => ({ name: s.id, description: s.description, voice_id: s.id }));
      return this.voices;
    } catch {
      this.voices = [];
      return this.voices;
    }
  }

  async generateTts(text, voiceId) {
    const resp = await fetch(this.apiUrl + this.generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice: voiceId || 'Vivian', model: 'qwen3-tts-0.6b-customvoice' }),
    });
    if (!resp.ok) throw new Error('TTS generation failed: ' + resp.status);
    return resp;
  }
}

if (typeof SillyTavern !== 'undefined') {
  const provider = new Qwen3TTSProvider();
  SillyTavern.getContext().registerTtsProvider(provider);
}
