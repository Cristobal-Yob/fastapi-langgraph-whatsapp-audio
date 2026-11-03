import { Gateway } from './gateway.mjs';
import { eligibleText } from './guard.mjs';
import { createOperatorServer } from './server.mjs';

const audio=process.env.APP_VARIANT==='whatsapp-audio';
let parse=(item,identities)=>{const text=eligibleText(item,identities);return text ? {kind:'text',text} : null;};
let makePipeline=()=>null;
if(audio) {
  const {eligibleInput}=await import('./input-guard.mjs');parse=eligibleInput;
  const {AudioPipeline,validateAudioConfig}=await import('./audio.mjs');
  const {ElevenLabsClient}=await import('./elevenlabs.mjs');
  const {MediaBoundary}=await import('./media.mjs');
  const config=validateAudioConfig({api_key:process.env.ELEVENLABS_API_KEY,base_url:'https://api.elevenlabs.io',
    stt_model:'scribe_v2',tts_model:'eleven_v4_turbo',voice_id:process.env.ELEVENLABS_VOICE_ID});
  makePipeline=()=>new AudioPipeline({voice:new ElevenLabsClient(config),media:new MediaBoundary(null)});
}
const createGateway=()=>new Gateway({parse,audio,pipeline:makePipeline()});

const {server,close}=createOperatorServer({createGateway,token:process.env.AGENT_API_TOKEN,origin:process.env.PUBLIC_ORIGIN});
server.listen(Number(process.env.PORT??8000),'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
  server.close();void close().finally(()=>process.exit(0));
  setTimeout(()=>process.exit(1),20000).unref();
});
