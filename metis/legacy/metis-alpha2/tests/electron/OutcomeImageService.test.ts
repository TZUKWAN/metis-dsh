import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OUTCOME_IMAGE_SECRET_REF } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeImageService } from '../../electron/OutcomeImageService.js';
import { OutcomeMediaService } from '../../electron/OutcomeMediaService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { PersonalizationSecretVault, type PersonalizationSafeStoragePort } from '../../electron/PersonalizationSecretVault.js';

class TestSafeStorage implements PersonalizationSafeStoragePort {
  readonly #key = randomBytes(32);
  isEncryptionAvailable(): boolean { return true; }
  getSelectedStorageBackend(): string { return 'secret-service'; }
  encryptString(value: string): Buffer { const nonce=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.#key,nonce); const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]); }
  decryptString(value: Buffer): string { const decipher=createDecipheriv('aes-256-gcm',this.#key,value.subarray(0,12)); decipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8'); }
}

describe('OutcomeImageService', () => {
  let root: string; let db: Database.Database; let repository: OutcomeRepository; let media: OutcomeMediaService; let vault: PersonalizationSecretVault; let outcomeId: string;
  beforeEach(async () => {
    root=await fs.mkdtemp(path.join(os.tmpdir(),'metis-outcome-image-'));
    db=new Database(':memory:'); db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('project-image','image','','','active','','','{}',1,1,1,'user');
    repository=new OutcomeRepository(db);
    outcomeId=repository.create({projectId:'project-image',categoryId:null,title:'配图',kind:'image',content:{type:'other',text:'',media:null},note:''}).outcome.id;
    media=new OutcomeMediaService(db,path.join(root,'outcome-media'));
    vault=new PersonalizationSecretVault(root,new TestSafeStorage());
  });
  afterEach(async () => { if (db) db.close(); if (root) await fs.rm(root,{recursive:true,force:true}); });

  it('requires the existing Vault key, sends saved configuration to the provider, and persists a readable PNG', async () => {
    let call: { endpoint: string; authorization: string | null; body: Record<string, unknown> } | undefined;
    const service=new OutcomeImageService({db,repository,media,secretVault:vault,now:()=>100,fetchImpl:async (input, init) => {
      call={endpoint:String(input),authorization:new Headers(init?.headers).get('authorization'),body:JSON.parse(String(init?.body)) as Record<string,unknown>};
      return new Response(JSON.stringify({data:[{b64_json:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64')}]}),{status:200,headers:{'content-type':'application/json'}});
    }});
    expect(service.saveSettings({provider:'OpenAI compatible',model:'gpt-image-1',endpoint:'https://images.example.test/v1/generate',defaultQuality:'high',apiKeyRef:OUTCOME_IMAGE_SECRET_REF})).toEqual({ok:false,code:'secret_not_found'});
    const stored=await vault.set({contractVersion:1,operationId:'00000000-0000-4000-8000-000000000001',expectedRevision:0,name:'OUTCOME_IMAGE_API_KEY',value:'image-secret'});
    expect(stored.ok).toBe(true);
    expect(service.saveSettings({provider:'OpenAI compatible',model:'gpt-image-1',endpoint:'https://images.example.test/v1/generate',defaultQuality:'high',apiKeyRef:OUTCOME_IMAGE_SECRET_REF})).toMatchObject({ok:true,settings:{hasApiKey:true}});
    expect((db.prepare('SELECT encrypted_api_key FROM image_generation_settings WHERE id=1').get() as {encrypted_api_key:string}).encrypted_api_key).toBe(OUTCOME_IMAGE_SECRET_REF);
    const generated=await service.generate({projectId:'project-image',outcomeId,prompt:'研究图表',visualContext:'蓝色，16:9',quality:'low'});
    expect(generated).toMatchObject({ok:true,mimeType:'image/png',media:{mediaType:'image/png'}});
    expect(call).toMatchObject({endpoint:'https://images.example.test/v1/generate',authorization:'Bearer image-secret',body:{model:'gpt-image-1',quality:'low',response_format:'b64_json'}});
    expect(String(call?.body.prompt)).toContain('Visual context: 蓝色，16:9');
    if (!generated.ok) throw new Error('expected generated media');
    expect(await media.readDataUrl('project-image',outcomeId,generated.media.id)).toMatch(/^data:image\/png;base64,/u);
  });

  it('keeps provider HTTP and malformed provider bytes distinguishable and never writes media for either', async () => {
    const configure=async (fetchImpl: typeof fetch) => {
      const service=new OutcomeImageService({db,repository,media,secretVault:vault,fetchImpl});
      await vault.set({contractVersion:1,operationId:'00000000-0000-4000-8000-000000000002',expectedRevision:0,name:'OUTCOME_IMAGE_API_KEY',value:'image-secret'});
      expect(service.saveSettings({provider:'OpenAI compatible',model:'gpt-image-1',endpoint:'https://images.example.test/v1/generate',defaultQuality:'standard',apiKeyRef:OUTCOME_IMAGE_SECRET_REF}).ok).toBe(true);
      return service;
    };
    const http=await configure(async () => new Response('unavailable',{status:503}));
    await expect(http.generate({projectId:'project-image',outcomeId,prompt:'图'})).resolves.toEqual({ok:false,code:'image_generation_provider_http_error'});
    expect((db.prepare('SELECT COUNT(*) AS n FROM outcome_media').get() as {n:number}).n).toBe(0);
    db.prepare('DELETE FROM image_generation_settings').run();
    const malformed=await configure(async () => new Response(JSON.stringify({data:[{b64_json:'not-base64'}]}),{status:200}));
    await expect(malformed.generate({projectId:'project-image',outcomeId,prompt:'图'})).resolves.toEqual({ok:false,code:'image_generation_provider_response_invalid'});
    expect((db.prepare('SELECT COUNT(*) AS n FROM outcome_media').get() as {n:number}).n).toBe(0);
  });
});
