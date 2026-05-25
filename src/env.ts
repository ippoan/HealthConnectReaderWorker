export interface Env {
  WORKER_ENV: string;
  UPLOAD_TOKEN: string;
  R2: R2Bucket;
}

export type AppEnv = { Bindings: Env };
