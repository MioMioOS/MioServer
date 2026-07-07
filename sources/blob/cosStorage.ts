/**
 * cosStorage — 腾讯云 COS 对象存储接入(附件直传,#D-perf)。
 *
 * 架构:server 只发预签名 URL,字节流走 浏览器/daemon ↔ COS 直连,
 * 完全绕开服务器公网带宽(旧路径:base64 JSON → Postgres bytea,5MB 图
 * 在小带宽机上要 7-13s)。
 *
 * 开关:四个环境变量齐全才启用(COS_SECRET_ID / COS_SECRET_KEY /
 * COS_BUCKET / COS_REGION);缺任一则 cosEnabled()=false,所有调用方
 * 回退到 bytea 旧路径——部署顺序因此无关紧要。
 *
 * 兼容:老附件(data 非空、storageKey 空)永远走旧路径;新附件写
 * storageKey、data 置空。读取按行内字段分流,无需数据迁移。
 */

import COS from 'cos-nodejs-sdk-v5';

const SECRET_ID = process.env.COS_SECRET_ID ?? '';
const SECRET_KEY = process.env.COS_SECRET_KEY ?? '';
const BUCKET = process.env.COS_BUCKET ?? '';
const REGION = process.env.COS_REGION ?? '';
// 可选:自定义加速域(如 image.wdao.chat,CNAME 到桶)。设置后预签名 URL 用它。
const DOMAIN = process.env.COS_DOMAIN ?? '';

const enabled = !!(SECRET_ID && SECRET_KEY && BUCKET && REGION);
const cos = enabled ? new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY }) : null;

export function cosEnabled(): boolean { return enabled; }

/** Object key layout: att/<workroomId>/<attachmentId>/<filename>. */
export function cosKeyFor(workroomId: string, attachmentId: string, filename: string): string {
  // Strip path separators from the filename; COS keys are flat strings.
  const safe = filename.replace(/[/\\]/g, '_');
  return `att/${workroomId}/${attachmentId}/${safe}`;
}

function presign(key: string, method: 'PUT' | 'GET', expiresSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    cos!.getObjectUrl(
      {
        Bucket: BUCKET, Region: REGION, Key: key, Method: method, Sign: true, Expires: expiresSec,
        ...(DOMAIN ? { Domain: DOMAIN, Protocol: 'https:' } : {}),
      },
      (err, data) => (err ? reject(err) : resolve(data.Url)),
    );
  });
}

/** 10-minute presigned upload URL (browser/daemon PUTs the raw bytes). */
export function presignPut(key: string): Promise<string> { return presign(key, 'PUT', 600); }

/** 10-minute presigned download URL (302 target from the blob routes). */
export function presignGet(key: string): Promise<string> { return presign(key, 'GET', 600); }

/** HEAD the object to confirm the client really uploaded it (complete step). */
export function cosHead(key: string): Promise<{ size: number } | null> {
  return new Promise((resolve) => {
    cos!.headObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err, data) => {
      if (err) return resolve(null);
      const len = Number(data.headers?.['content-length'] ?? 0);
      resolve({ size: len });
    });
  });
}
