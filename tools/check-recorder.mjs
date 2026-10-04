/**
 * 录音模块的自检：node tools/check-recorder.mjs
 *
 * MediaRecorder 在 node 里不存在，所以能测的是两件事：
 *   1. **格式挑选**是纯逻辑（pickMimeType），要按优先级挑、要能兜住"一个都不支持"
 *   2. 浏览器不支持录音时，整个类要能**静默降级**，绝不能把异常漏给调用方
 */
import assert from 'node:assert/strict'
import { MicRecorder, pickMimeType } from '../src/lib/recorder.ts'

// ------------------------------------------------------------ 1. 格式挑选
{
  // 首选 opus/webm
  assert.equal(
    pickMimeType((t) => t === 'audio/webm;codecs=opus'),
    'audio/webm;codecs=opus',
    '支持 opus 就该选它'
  )

  // 只有裸 webm 时退回裸 webm
  assert.equal(
    pickMimeType((t) => t === 'audio/webm'),
    'audio/webm',
    '没有 opus 就退回裸 webm'
  )

  // 全支持时按优先级取第一个
  assert.equal(pickMimeType(() => true), 'audio/webm;codecs=opus', '全支持时取优先级最高的')

  // 一个都不支持 -> 空串，交给 MediaRecorder 用默认值
  assert.equal(pickMimeType(() => false), '', '一个都不支持要返回空串而不是乱猜')

  // isSupported 抛异常也不能漏出去（某些实现对畸形字符串会抛）
  assert.equal(
    pickMimeType(() => {
      throw new Error('boom')
    }),
    '',
    'isSupported 抛异常要能兜住'
  )

  // 只认 mp4（Safari）时也要挑得出来
  assert.equal(pickMimeType((t) => t === 'audio/mp4'), 'audio/mp4', 'Safari 兜底')

  // 返回值必须来自候选表，不能凭空造
  const picked = pickMimeType((t) => t.startsWith('audio/'))
  assert.ok(picked.startsWith('audio/'), '挑出来的必须是合法音频类型')
}

// ------------------------------------------- 2. node 里没有 MediaRecorder，要降级
{
  const rec = new MicRecorder()
  assert.equal(rec.supported, false, 'node 里没有 MediaRecorder，supported 应该是 false')
  assert.equal(rec.recording, false)
  assert.equal(rec.seconds, 0)
  assert.equal(rec.result, null, '一开始没有录音结果')

  // 没有 MediaRecorder 时 start 必须返回 false 而不是抛
  const fakeStream = {}
  assert.equal(rec.start(fakeStream), false, '不支持时 start 要返回 false')

  // stop / clear 也必须能安全调用
  assert.doesNotThrow(() => rec.stop(), '没在录时 stop 不该抛')
  assert.doesNotThrow(() => rec.clear(), '没录过时 clear 不该抛')

  // 回调可以为空，不能因此崩
  assert.doesNotThrow(() => {
    rec.onResult = null
    rec.clear()
  })
}

// ------------------------------------------------- 3. 状态查询在没录时要有意义
{
  const rec = new MicRecorder()
  // 连录都没开始，这些查询必须给出"空"而不是 NaN / undefined 乱飞
  assert.equal(rec.seconds, 0, '没在录时秒数应为 0')
  assert.equal(rec.result, null)
  const results = []
  rec.onResult = (r) => results.push(r)
  rec.clear()
  assert.equal(results.length, 1, 'clear 应该回调一次（告诉调用方录音没了）')
  assert.equal(results[0], null, '回调的值应是 null')
}

console.log('✓ 录音模块全部通过（格式优先级 / 全不支持兜底 / 异常兜底 / 无 MediaRecorder 降级）')
