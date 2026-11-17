// 复习时的语音作答：用 macOS 系统语音识别（能离线就离线）把麦克风里的话实时转成文字。
// 协议：stdout 每行一个 JSON 事件；stdin 收到 "stop" 结束收音并给出最终结果，"cancel" 或 EOF 直接退出。
//   {"type":"ready","onDevice":true}  {"type":"level","value":0.42}  {"type":"partial","text":"..."}
//   {"type":"final","text":"..."}     {"type":"error","code":"speech-denied","message":"..."}
// 构建：node scripts/build-speech-helper.cjs（输出 build/speech/memokeep-speech）。
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)
let outputLock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  outputLock.lock(); print(line); fflush(stdout); outputLock.unlock()
}
func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message]); exit(1)
}

let arguments = CommandLine.arguments
let localeId = arguments.firstIndex(of: "--locale").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "zh-CN"
// 提示词：这张卡片和词库里的术语，系统识别时优先往这些词上靠。
let contextTerms: [String] = arguments.firstIndex(of: "--terms").flatMap { index -> [String]? in
  guard arguments.indices.contains(index + 1), let data = arguments[index + 1].data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String]
}.map { Array($0.prefix(100)) } ?? []
// 设置 › 语音作答 ›「只在本机识别」关掉时传 --allow-server，允许使用 Apple 的在线识别。
let allowServer = arguments.contains("--allow-server")

if arguments.contains("--check") {
  let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId))
  emit(["type": "check", "available": recognizer?.isAvailable ?? false, "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "speech": SFSpeechRecognizer.authorizationStatus().rawValue, "microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue])
  exit(0)
}

// 系统识别在停顿几秒后会开始新的一句：部分结果从新一句重新算，或者上一句直接给出 isFinal。
// 所以按「段」上报：每段结束发 segmentEnd，录音中任务结束就接着开新任务；拼接由界面完成（web/domain/voice-answer.js）。
final class Session {
  let engine = AVAudioEngine()
  var recognizer: SFSpeechRecognizer?
  var request: SFSpeechAudioBufferRecognitionRequest?
  var task: SFSpeechRecognitionTask?
  var lastText = ""
  var heardAnything = false
  var recording = false
  var finished = false
  var lastLevelAt = Date.distantPast
  var onDevice = false

  func finish(_ text: String) {
    if finished { return }
    finished = true
    emit(["type": "final", "text": text])
    exit(0)
  }

  func start() {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else { fail("unsupported", "系统不支持这种语言的语音识别") }
    guard recognizer.isAvailable else { fail("unavailable", "语音识别暂时不可用") }
    self.recognizer = recognizer
    onDevice = recognizer.supportsOnDeviceRecognition
    if !allowServer && !onDevice { fail("offline-unsupported", "这台电脑不支持在本机识别这种语言") }

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { fail("no-microphone", "没有找到可用的麦克风") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      self.request?.append(buffer)
      let now = Date()
      guard now.timeIntervalSince(self.lastLevelAt) > 0.066, let samples = buffer.floatChannelData?[0] else { return }
      self.lastLevelAt = now
      var sum: Float = 0
      let count = Int(buffer.frameLength)
      for index in 0..<count { sum += samples[index] * samples[index] }
      let rms = count > 0 ? sqrt(sum / Float(count)) : 0
      // 把 -50dB…0dB 映射到 0…1，说话时大约 0.4–0.8。
      let db = 20 * log10(max(rms, 0.000_01))
      emit(["type": "level", "value": Double(max(0, min(1, (db + 50) / 50)))])
    }

    recording = true
    beginTask()
    engine.prepare()
    do { try engine.start() } catch { fail("no-microphone", "麦克风无法启动：\(error.localizedDescription)") }
    emit(["type": "ready", "onDevice": onDevice])
  }

  // 开一个新的识别任务（新的一段）。旧任务的回调用 task 身份判断，过期的直接忽略。
  func beginTask() {
    guard let recognizer else { return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.requiresOnDeviceRecognition = !allowServer
    if #available(macOS 13, *) { request.addsPunctuation = true }
    if !contextTerms.isEmpty { request.contextualStrings = contextTerms }
    self.request = request
    lastText = ""
    var current: SFSpeechRecognitionTask?
    current = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, let current, self.task === current else { return }
        self.handle(result: result, error: error)
      }
    }
    task = current
  }

  func handle(result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      let text = result.bestTranscription.formattedString
      if !text.isEmpty { heardAnything = true }
      lastText = text
      // 一句说完（系统给出 isFinal，或带上了这句的语音信息）就标记段结束。
      let segmentEnd = result.isFinal || result.speechRecognitionMetadata != nil
      if !recording && result.isFinal { finish(text); return }
      emit(["type": "partial", "text": text, "segmentEnd": segmentEnd])
      if result.isFinal && recording { request?.endAudio(); beginTask() }
      return
    }
    guard let error else { return }
    if !recording { finish(lastText); return }
    // 录音中：长时间没说话（No speech detected）或任务被系统结束，接着开新一段，不打断用户。
    let nsError = error as NSError
    if heardAnything || (nsError.domain == "kAFAssistantErrorDomain" && [203, 216, 1110].contains(nsError.code)) {
      if !lastText.isEmpty { emit(["type": "partial", "text": lastText, "segmentEnd": true]) }
      request?.endAudio()
      beginTask()
      return
    }
    fail("recognition", error.localizedDescription)
  }

  func stop() {
    recording = false
    if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
    request?.endAudio()
    // 正常情况下系统很快给出这一段的最终结果；兜底 2.5 秒后用最后一次的文字结束。
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.finish(self?.lastText ?? "") }
  }
}

let session = Session()
func startSession() { session.start() }
func stopSession() { session.stop() }

func authorize() {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .denied, .restricted: fail("microphone-denied", "没有麦克风权限")
  case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      DispatchQueue.main.async { if granted { authorizeSpeech() } else { fail("microphone-denied", "没有麦克风权限") } }
    }
  default: authorizeSpeech()
  }
}
func authorizeSpeech() {
  SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
      switch status {
      case .authorized: startSession()
      case .notDetermined: fail("speech-denied", "还没有允许语音识别")
      default: fail("speech-denied", "没有语音识别权限")
      }
    }
  }
}

// 读 stdin：stop 结束收音，cancel / EOF 退出。父进程退出时管道关闭，这里也跟着退出。
Thread {
  while let line = readLine(strippingNewline: true) {
    let command = line.trimmingCharacters(in: .whitespaces)
    if command == "stop" { DispatchQueue.main.async { stopSession() } }
    else if command == "cancel" { exit(0) }
  }
  exit(0)
}.start()

authorize()
RunLoop.main.run()
