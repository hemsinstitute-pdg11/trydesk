// trydesk-capture.exe — TryDesk's fast capture path on Windows (host side).
//
// Chromium's screen capture (Windows Graphics Capture with Windows' default pacing) delivers about 60 new frames a
// second and adds ~35 ms before the picture even reaches the encoder (measured 2026-11-02). This helper skips it:
//   DXGI Desktop Duplication (frames as fast as the monitor refreshes, kept on the GPU)
//   -> cursor drawn in (as Chromium does, so the viewer sees the remote pointer)
//   -> D3D11 video processor BGRA -> NV12 (GPU)
//   -> hardware H.264 encoder (Media Foundation MFT: NVIDIA / AMD / Intel), low-latency mode
//   -> stdout, one packet per encoded frame.
// A frame is sent only when the screen or the cursor changed (an idle desktop costs ~0 bandwidth), paced to --fps.
// It is a separate process on purpose: a driver crash here never takes TryDesk down, and TryDesk falls back to the
// normal WebRTC capture whenever this exits.
//
// Usage: trydesk-capture.exe --rect X,Y,W,H [--fps 240] [--mbps 50] [--hevc]
//   --rect: the monitor in physical desktop pixels (the output whose desktop rectangle matches is captured)
//   --hevc: encode H.265 when the GPU has a hardware H.265 encoder (H.264 otherwise; "codec" in the info packet)
// stdout packets (little-endian): u32 payloadLength, u8 type, u8 flags, u16 reserved, f64 captureEpochMs, payload
//   type 1 = H.264 / H.265 access unit (Annex-B), flags bit0 = keyframe
//   type 2 = info text (UTF-8 JSON: {"w":..,"h":..,"codec":"h264"|"hevc","encoder":".."} once at start)
// stdin: one JSON-ish command per line: {"cmd":"key"} | {"cmd":"rate","mbps":N,"fps":N} | {"cmd":"stop"}
//   with --udp (see trydesk-udp.h): {"cmd":"udpkey","hex":"<64 hex>"} | {"cmd":"peer","ip":"a.b.c.d","port":N} |
//   {"cmd":"udp","on":0|1}. The info packet at start then carries "udpPort"; frames go out on UDP instead of
//   stdout as soon as the viewer's receiver answers, and come back to stdout if it goes quiet.
//   Input on the desktop this helper captures (the TryDesk service's host routes input here while the secure desktop
//   is up): {"cmd":"in","t":"move","x":N,"y":N} (physical desktop pixels) | {"cmd":"in","t":"down"|"up","b":"left"|
//   "right"|"middle"} | {"cmd":"in","t":"wheel","wy":N,"wx":N} (wheel units, 120 a notch) | {"cmd":"in","t":"key",
//   "vk":N,"up":0|1} | {"cmd":"in","t":"text","u":"<UTF-16 units, 4 hex digits each>"} (typed text, at most 200 units a line).
// Secure desktop: the UAC prompt and the lock screen are a separate desktop ("Winlogon") that only SYSTEM can open.
//   Run by the service's host (SYSTEM) this helper follows whichever desktop has the input; run as a user it can't,
//   and behaves as before.
// --recv --port N: the viewer end. No capture; receives frames on UDP and writes them to stdout as type 1 packets
//   (flags bit1 = a frame before this one was lost). Same stdin commands (udpkey, peer, stop).
// --loopback: no picture; the PC's sound (what its speakers play) for a session whose picture comes from this helper
//   (TryDesk run as administrator: Chromium can capture neither the screen nor, without the screen, the sound).
//   type 3 packets: u32 sampleRate, u16 channels, u16 0, then 32-bit float samples, interleaved, at most 2 channels.
//   Info packet {"audio":"on",...} once the output device is open, {"audio":"none"} when there is none.
// Exit codes: 0 stopped, 2 monitor not found, 3 capture lost (display change / secure desktop), 4 no hardware
// encoder, 5 setup failed.
#define NOMINMAX
#define _WIN32_WINNT 0x0A00   // Windows 10 (MFTEnum2: pick the encoder on the monitor's GPU)
#include "trydesk-udp.h"      // winsock2.h must come before windows.h
#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>
#include <icodecapi.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>
#include <io.h>
#include <fcntl.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ComPtr;
using clk = std::chrono::steady_clock;

static std::mutex g_outLock;
static double epochMs() { FILETIME ft; GetSystemTimePreciseAsFileTime(&ft); ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime; return (double)(u.QuadPart - 116444736000000000ULL) / 10000.0; }
static void writePacket(uint8_t type, uint8_t flags, double t, const void* data, uint32_t len) {
  uint8_t hdr[16]; memcpy(hdr, &len, 4); hdr[4] = type; hdr[5] = flags; hdr[6] = hdr[7] = 0; memcpy(hdr + 8, &t, 8);
  std::lock_guard<std::mutex> g(g_outLock);
  if (fwrite(hdr, 1, 16, stdout) != 16 || (len && fwrite(data, 1, len, stdout) != len)) ExitProcess(0);   // TryDesk went away
  fflush(stdout);
}
static void info(const std::string& json) { writePacket(2, 0, epochMs(), json.data(), (uint32_t)json.size()); }
[[noreturn]] static void quit(int code, const char* why) { info(std::string("{\"exit\":") + std::to_string(code) + ",\"why\":\"" + why + "\"}"); fflush(stdout); ExitProcess(code); }

// Commands from TryDesk (stdin), read on their own thread.
static std::atomic<bool> g_stop{ false }, g_wantKey{ false }, g_rateChanged{ false };
static std::atomic<int> g_fps{ 240 }, g_mbps{ 50 };
static int numberAfter(const std::string& s, const char* key) { auto p = s.find(key); if (p == std::string::npos) return -1; p = s.find(':', p); if (p == std::string::npos) return -1; return atoi(s.c_str() + p + 1); }
static std::string stringAfter(const std::string& s, const char* key) { auto p = s.find(key); if (p == std::string::npos) return ""; const auto c = s.find(':', p); if (c == std::string::npos) return ""; p = s.find('"', c + 1); if (p == std::string::npos) return ""; auto e = s.find('"', p + 1); return e == std::string::npos ? "" : s.substr(p + 1, e - p - 1); }   // (no npos + 1 wrap: audit 19 Nov)
// The UDP link (with --udp on the host, always on the viewer's --recv end); see trydesk-udp.h.
static tdudp::Link g_link; static tdudp::Sender* g_sender = nullptr;

// Attach the calling thread to the desktop that has the input now (Default, or Winlogon while a UAC prompt or the
// lock screen is up). Only SYSTEM may open Winlogon; for anyone else this stays on Default. A thread with windows or
// hooks can't move: this helper's capture and command threads have none. True when the thread moved.
static bool followInputDesktop() {
  thread_local HDESK mine = nullptr;
  HDESK d = OpenInputDesktop(0, FALSE, GENERIC_ALL);
  if (!d) return false;
  wchar_t want[64] = L"", have[64] = L""; DWORD n = 0;
  GetUserObjectInformationW(d, UOI_NAME, want, sizeof want, &n);
  GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, have, sizeof have, &n);
  if (!_wcsicmp(want, have)) { CloseDesktop(d); return false; }
  if (!SetThreadDesktop(d)) { CloseDesktop(d); return false; }
  if (mine) CloseDesktop(mine);
  mine = d;
  return true;
}
// One input command from TryDesk, done on the input desktop (see the header).
static void doInput(const std::string& s) {
  followInputDesktop();
  const std::string t = stringAfter(s, "\"t\"");
  if (t == "move") { SetCursorPos(numberAfter(s, "\"x\""), numberAfter(s, "\"y\"")); return; }
  if (t == "down" || t == "up") {
    const std::string b = stringAfter(s, "\"b\""); const bool up = t == "up";
    const DWORD f = b == "right" ? (up ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_RIGHTDOWN) : b == "middle" ? (up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN) : (up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN);
    INPUT in = {}; in.type = INPUT_MOUSE; in.mi.dwFlags = f; SendInput(1, &in, sizeof in); return;
  }
  if (t == "wheel") {
    const int wy = numberAfter(s, "\"wy\""), wx = numberAfter(s, "\"wx\"");
    if (wy && wy != -1) { INPUT in = {}; in.type = INPUT_MOUSE; in.mi.dwFlags = MOUSEEVENTF_WHEEL; in.mi.mouseData = (DWORD)wy; SendInput(1, &in, sizeof in); }
    if (wx && wx != -1) { INPUT in = {}; in.type = INPUT_MOUSE; in.mi.dwFlags = MOUSEEVENTF_HWHEEL; in.mi.mouseData = (DWORD)wx; SendInput(1, &in, sizeof in); }
    return;
  }
  if (t == "key") {
    const int vk = numberAfter(s, "\"vk\""); if (vk <= 0 || vk > 0xFE) return;
    static const int ext[] = { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90 };
    INPUT in = {}; in.type = INPUT_KEYBOARD; in.ki.wVk = (WORD)vk; in.ki.wScan = (WORD)(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) & 0xFF);
    if (numberAfter(s, "\"up\"") == 1) in.ki.dwFlags |= KEYEVENTF_KEYUP;
    for (int e : ext) if (e == vk) in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    SendInput(1, &in, sizeof in);
    return;
  }
  if (t == "text") {
    // Typed text from a phone viewer (its on-screen keyboard sends characters, not keys): UTF-16 units as 4 hex digits.
    const std::string u = stringAfter(s, "\"u\"");
    std::vector<INPUT> v;
    for (size_t i = 0; i + 4 <= u.size() && v.size() < 400; i += 4) {
      const WORD c = (WORD)strtoul(u.substr(i, 4).c_str(), nullptr, 16);
      if (c < 0x20) continue;   // control characters come as keys (Enter, Tab)
      INPUT in = {}; in.type = INPUT_KEYBOARD; in.ki.wScan = c; in.ki.dwFlags = KEYEVENTF_UNICODE; v.push_back(in);
      in.ki.dwFlags |= KEYEVENTF_KEYUP; v.push_back(in);
    }
    if (!v.empty()) SendInput((UINT)v.size(), v.data(), sizeof(INPUT));
  }
}
static void readCommands() {
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    std::string s(line);
    if (s.find("\"cmd\":\"in\"") != std::string::npos) { doInput(s); continue; }   // first: its "t":"key" isn't a keyframe ask
    if (s.find("\"stop\"") != std::string::npos) { g_stop = true; break; }
    else if (s.find("\"udpkey\"") != std::string::npos) {
      const std::string hex = stringAfter(s, "\"hex\""); std::vector<uint8_t> key;
      for (size_t i = 0; i + 1 < hex.size() && key.size() < 32; i += 2) key.push_back((uint8_t)strtoul(hex.substr(i, 2).c_str(), nullptr, 16));
      if (!g_link.setKey(key)) info("{\"udp\":\"bad key\"}");
    }
    else if (s.find("\"peer\"") != std::string::npos) { const int port = numberAfter(s, "\"port\""); if (port > 0 && port < 65536) g_link.addCandidate(stringAfter(s, "\"ip\""), (uint16_t)port); }
    else if (s.find("\"udp\"") != std::string::npos) { if (g_sender) g_sender->enabled = numberAfter(s, "\"on\"") != 0; }
    else if (s.find("\"key\"") != std::string::npos) g_wantKey = true;
    else if (s.find("\"rate\"") != std::string::npos) {
      int m = numberAfter(s, "\"mbps\""), f = numberAfter(s, "\"fps\"");
      if (m > 0) g_mbps = std::min(1000, m);
      if (f > 0) g_fps = std::max(1, std::min(240, f));
      g_rateChanged = true;
    }
  }
  g_stop = true;   // stdin closed: TryDesk is gone
}
// --recv: the viewer end of the UDP link. Whole frames go to stdout exactly like captured ones.
static int runRecv(uint16_t port) {
  if (!g_link.open(port, 1)) quit(5, "udp socket");
  info("{\"udpPort\":" + std::to_string(g_link.port()) + "}");
  std::thread(readCommands).detach();
  std::thread([] { while (!g_stop) Sleep(50); ExitProcess(0); }).detach();
  tdudp::Receiver rx(g_link);
  rx.run([](uint8_t flags, double t, const uint8_t* d, uint32_t n) { writePacket(1, flags, t, d, n); }, [](const std::string& j) { info(j); });
  return 0;
}

// --loopback: WASAPI loopback of the default output device. Shared-mode loopback delivers the mix format (on most PCs
// 32-bit float, 48 kHz, stereo); other formats are converted to float here, and 5.1 / 7.1 is mixed down to stereo
// (centre and surround included: films and games put the voices in the centre). While nothing plays Windows delivers
// no packets at all, so 10 ms of silence are sent instead: the audio track's clock keeps running and the first sound
// after a quiet spell is not held back. The device is opened again when it goes away and when Windows' default output
// changes (speakers -> headset in the taskbar: the old device stays active but goes quiet).
static void sendAudio(UINT rate, UINT ch, const float* samples, UINT frames) {
  std::vector<uint8_t> p(8 + (size_t)frames * ch * 4);
  memcpy(p.data(), &rate, 4); const uint16_t c16 = (uint16_t)ch, z = 0; memcpy(p.data() + 4, &c16, 2); memcpy(p.data() + 6, &z, 2);
  if (samples) memcpy(p.data() + 8, samples, (size_t)frames * ch * 4); else memset(p.data() + 8, 0, (size_t)frames * ch * 4);
  writePacket(3, 0, epochMs(), p.data(), (uint32_t)p.size());
}
static int runLoopback() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) quit(5, "com startup");
  std::thread(readCommands).detach();
  std::thread([] { while (!g_stop) Sleep(50); ExitProcess(0); }).detach();
  timeBeginPeriod(1);
  bool saidNone = false;
  // The id of Windows' current default output (empty when there is none).
  auto defaultId = [](IMMDeviceEnumerator* en) -> std::wstring {
    ComPtr<IMMDevice> d; LPWSTR id = nullptr; std::wstring s;
    if (en && SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &d)) && SUCCEEDED(d->GetId(&id)) && id) { s = id; CoTaskMemFree(id); }
    return s;
  };
  while (!g_stop) {
    ComPtr<IMMDeviceEnumerator> en; ComPtr<IMMDevice> dev; ComPtr<IAudioClient> ac; ComPtr<IAudioCaptureClient> cc; WAVEFORMATEX* wf = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
    std::wstring devId; { LPWSTR id = nullptr; if (dev && SUCCEEDED(dev->GetId(&id)) && id) { devId = id; CoTaskMemFree(id); } }
    if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(ac.GetAddressOf()));
    if (SUCCEEDED(hr)) hr = ac->GetMixFormat(&wf);
    // 100 ms of room: a loopback buffer adds no delay (packets come as they are mixed), it only has to outlast a busy moment.
    if (SUCCEEDED(hr)) hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 1000000, 0, wf, nullptr);
    if (SUCCEEDED(hr)) hr = ac->GetService(IID_PPV_ARGS(&cc));
    if (SUCCEEDED(hr)) hr = ac->Start();
    if (FAILED(hr)) {
      if (wf) CoTaskMemFree(wf);
      if (!saidNone) { char b[80]; snprintf(b, sizeof b, "{\"audio\":\"none\",\"hr\":\"0x%08lx\"}", (unsigned long)hr); info(b); saidNone = true; }
      Sleep(1000); continue;   // no output device right now: look again
    }
    saidNone = false;
    const UINT rate = wf->nSamplesPerSec, inCh = std::max<UINT>(1, wf->nChannels), bits = wf->wBitsPerSample, align = wf->nBlockAlign;
    // Bytes per sample from the frame size, not wBitsPerSample: a 24-bit-in-32 format can report either.
    const UINT bps = std::max<UINT>(1, align / inCh);
    bool isFloat = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    DWORD mask = 0;
    if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) { auto* x = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(wf); isFloat = x->SubFormat.Data1 == 3; mask = x->dwChannelMask; }   // 3 = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    CoTaskMemFree(wf);
    const UINT ch = std::min<UINT>(2, inCh);
    // Down-mix weights for each input channel to (left, right). Channels come in the order of their speaker bits.
    std::vector<float> wl(inCh, 0.f), wr(inCh, 0.f);
    if (inCh <= 2) { wl[0] = 1.f; if (inCh == 2) wr[1] = 1.f; }
    else {
      DWORD bitsLeft = mask ? mask : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT);
      for (UINT c = 0; c < inCh; c++) {
        DWORD sp = 0; if (bitsLeft) { sp = bitsLeft & (~bitsLeft + 1); bitsLeft &= bitsLeft - 1; }   // lowest remaining speaker bit
        switch (sp) {
          case SPEAKER_FRONT_LEFT: wl[c] = 1.f; break;
          case SPEAKER_FRONT_RIGHT: wr[c] = 1.f; break;
          case SPEAKER_FRONT_CENTER: case SPEAKER_BACK_CENTER: wl[c] = wr[c] = 0.707f; break;
          case SPEAKER_BACK_LEFT: case SPEAKER_SIDE_LEFT: case SPEAKER_FRONT_LEFT_OF_CENTER: wl[c] = 0.707f; break;
          case SPEAKER_BACK_RIGHT: case SPEAKER_SIDE_RIGHT: case SPEAKER_FRONT_RIGHT_OF_CENTER: wr[c] = 0.707f; break;
          default: break;   // low-frequency and anything unknown left out
        }
      }
    }
    const float surroundGain = inCh > 2 ? 0.6f : 1.f;   // several channels add up: keep the mix from clipping
    { char b[160]; snprintf(b, sizeof b, "{\"audio\":\"on\",\"rate\":%u,\"channels\":%u,\"bits\":%u,\"float\":%d,\"mask\":%lu}", rate, inCh, bits, isFloat ? 1 : 0, (unsigned long)mask); info(b); }
    const UINT tenMs = std::max<UINT>(1, rate / 100);
    std::vector<float> buf;
    auto lastData = clk::now(), nextSilence = clk::now(), nextDevCheck = clk::now() + std::chrono::seconds(1);
    bool reopen = false;
    while (!g_stop) {
      // The default output changed (headset chosen in the taskbar): the old device may still be active, but quiet.
      if (clk::now() >= nextDevCheck) { nextDevCheck = clk::now() + std::chrono::seconds(1); if (defaultId(en.Get()) != devId) { reopen = true; break; } }
      UINT32 n = 0;
      if (FAILED(cc->GetNextPacketSize(&n))) { reopen = true; break; }
      if (n == 0) {
        const auto now = clk::now();
        if (now - lastData > std::chrono::milliseconds(30) && now >= nextSilence) {
          sendAudio(rate, ch, nullptr, tenMs);
          nextSilence += std::chrono::milliseconds(10); if (nextSilence < now) nextSilence = now + std::chrono::milliseconds(10);
        }
        Sleep(2); continue;
      }
      BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
      if (FAILED(cc->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) { reopen = true; break; }
      buf.assign((size_t)frames * ch, 0.f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
        for (UINT32 f = 0; f < frames; f++) {
          float l = 0.f, r = 0.f;
          for (UINT c = 0; c < inCh; c++) {
            const BYTE* s = data + (size_t)f * align + (size_t)c * bps;
            float v = 0.f;
            if (isFloat && bps == 4) memcpy(&v, s, 4);
            else if (!isFloat && bps == 2) { int16_t x; memcpy(&x, s, 2); v = x / 32768.f; }
            else if (!isFloat && bps == 3) { const int32_t x = (int32_t)((uint32_t)s[0] << 8 | (uint32_t)s[1] << 16 | (uint32_t)s[2] << 24) >> 8; v = x / 8388608.f; }
            else if (!isFloat && bps == 4) { int32_t x; memcpy(&x, s, 4); v = x / 2147483648.f; }   // 32-bit and 24-in-32 (high bytes)
            l += v * wl[c]; r += v * wr[c];
          }
          if (ch == 1) buf[f] = l;
          else { buf[(size_t)f * 2] = std::max(-1.f, std::min(1.f, l * surroundGain)); buf[(size_t)f * 2 + 1] = std::max(-1.f, std::min(1.f, r * surroundGain)); }
        }
      }
      cc->ReleaseBuffer(frames);
      if (frames) sendAudio(rate, ch, buf.data(), frames);
      lastData = clk::now(); nextSilence = lastData + std::chrono::milliseconds(10);
    }
    ac->Stop();
    if (!reopen) break;
    info("{\"audio\":\"reopen\"}"); Sleep(300);   // the device went away or the default changed: open the default one again
  }
  return 0;
}

// --- Cursor: DXGI hands the pointer shape and position separately; it is blended into the frame on the CPU
// (only the pointer's few hundred pixels), the way Chromium's capture shows it.
struct Cursor { std::vector<uint8_t> shape; DXGI_OUTDUPL_POINTER_SHAPE_INFO si{}; POINT pos{}; bool visible = false; };
static void blendCursor(const Cursor& c, uint8_t* px, UINT pitch, int x0, int y0, int w, int h) {
  // px is the w x h region of the desktop (BGRA) whose top-left is (x0,y0) on screen; the pointer's top-left is c.pos.
  const auto& si = c.si;
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    int cx = x0 + x - c.pos.x, cy = y0 + y - c.pos.y;
    uint8_t* d = px + y * pitch + x * 4;
    if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= (int)si.Height) continue;
      const uint8_t* s = c.shape.data() + cy * si.Pitch + cx * 4; unsigned a = s[3];
      for (int k = 0; k < 3; k++) d[k] = (uint8_t)((s[k] * a + d[k] * (255 - a)) / 255);
    } else if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= (int)si.Height) continue;
      const uint8_t* s = c.shape.data() + cy * si.Pitch + cx * 4;
      if (s[3]) { d[0] ^= s[0]; d[1] ^= s[1]; d[2] ^= s[2]; } else { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; }
    } else if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
      const int hh = (int)si.Height / 2;   // AND mask on top, XOR mask below, 1 bit per pixel
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= hh) continue;
      const uint8_t andBit = (c.shape[cy * si.Pitch + cx / 8] >> (7 - cx % 8)) & 1;
      const uint8_t xorBit = (c.shape[(cy + hh) * si.Pitch + cx / 8] >> (7 - cx % 8)) & 1;
      for (int k = 0; k < 3; k++) { uint8_t v = andBit ? d[k] : 0; d[k] = xorBit ? (uint8_t)(v ^ 0xFF) : v; }
    }
  }
}
// Encoder events arrive on Media Foundation's own thread: each encoded frame goes to stdout the moment it exists, and
// the capture loop is woken as soon as the encoder can take the next frame. (Polling for that between captures held
// 240 fps down to ~140, measured.)
class EncoderEvents : public IMFAsyncCallback {
 public:
  EncoderEvents(IMFTransform* enc, IMFMediaEventGenerator* gen) : enc_(enc), gen_(gen) { needEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr); }
  STDMETHODIMP QueryInterface(REFIID iid, void** p) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMFAsyncCallback)) { *p = static_cast<IMFAsyncCallback*>(this); AddRef(); return S_OK; }
    *p = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++ref_; }
  STDMETHODIMP_(ULONG) Release() override { return --ref_; }   // lives as long as the process
  STDMETHODIMP GetParameters(DWORD*, DWORD*) override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(IMFAsyncResult* r) override {
    ComPtr<IMFMediaEvent> ev;
    if (FAILED(gen_->EndGetEvent(r, &ev))) return S_OK;
    MediaEventType t; ev->GetType(&t);
    if (t == METransformNeedInput) { needInput++; SetEvent(needEvent); }
    else if (t == METransformHaveOutput) output();
    gen_->BeginGetEvent(this, nullptr);
    return S_OK;
  }
  void start() { gen_->BeginGetEvent(this, nullptr); }
  void submitted(double capturedAt) { std::lock_guard<std::mutex> g(m_); inflight_.push_back(capturedAt); }
  void unsubmitted() { std::lock_guard<std::mutex> g(m_); if (!inflight_.empty()) inflight_.pop_back(); }
  std::atomic<int> needInput{ 0 }, outCount{ 0 };
  HANDLE needEvent;
 private:
  void output() {
    MFT_OUTPUT_DATA_BUFFER ob = {}; DWORD st = 0;
    if (SUCCEEDED(enc_->ProcessOutput(0, 1, &ob, &st)) && ob.pSample) {
      UINT32 key = 0; ob.pSample->GetUINT32(MFSampleExtension_CleanPoint, &key);
      ComPtr<IMFMediaBuffer> mb; ob.pSample->ConvertToContiguousBuffer(&mb);
      BYTE* p; DWORD len;
      if (mb && SUCCEEDED(mb->Lock(&p, nullptr, &len))) {
        double t0;
        { std::lock_guard<std::mutex> g(m_); t0 = inflight_.empty() ? epochMs() : inflight_.front(); if (!inflight_.empty()) inflight_.pop_front(); }
        // With a viewer on the UDP link the frame goes straight out from here; otherwise (no link, link lost, or
        // TryDesk switched it off) through stdout and TryDesk's data channel as before.
        if (g_sender && g_sender->enabled && g_link.up()) g_sender->push(p, len, key != 0, t0);
        else writePacket(1, key ? 1 : 0, t0, p, len);
        outCount++;
        mb->Unlock();
      }
      ob.pSample->Release();
    }
    if (ob.pEvents) ob.pEvents->Release();
  }
  IMFTransform* enc_; IMFMediaEventGenerator* gen_;
  std::atomic<ULONG> ref_{ 1 }; std::mutex m_; std::deque<double> inflight_;
};

static int cursorWidth(const Cursor& c) { return (int)c.si.Width; }
static int cursorHeight(const Cursor& c) { return c.si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? (int)c.si.Height / 2 : (int)c.si.Height; }

// --raw-ok and no hardware video encoder on this PC (a virtual machine, Windows Sandbox, a server or an old PC): plain
// frames instead of H.264, which TryDesk then encodes itself. TryDesk asks for this only where the picture can come from
// nowhere else (the lock screen or login screen through the TryDesk service, TryDesk run as administrator). A 1080p frame
// is ~8 MB, so at most 8 frames a second and only after a change; a screen wider than 1920 px is sent at half size.
// Type 4 packets: u32 width, u32 height, then the rows, BGRA, 4 bytes a pixel, no padding.
static int runRaw(ID3D11Device* dev, ID3D11DeviceContext* ctx, IDXGIOutput1* out1, ComPtr<IDXGIOutputDuplication> dup, UINT W, UINT H, const DXGI_ADAPTER_DESC1& adesc) {
  const UINT step = W > 1920 ? 2 : 1, OW = (W / step) & ~1u, OH = (H / step) & ~1u;
  D3D11_TEXTURE2D_DESC sd = {}; sd.Width = W; sd.Height = H; sd.MipLevels = 1; sd.ArraySize = 1; sd.SampleDesc.Count = 1;
  sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> stage; if (FAILED(dev->CreateTexture2D(&sd, nullptr, &stage))) quit(5, "staging texture");
  char buf[320];
  snprintf(buf, sizeof buf, "{\"w\":%u,\"h\":%u,\"codec\":\"raw\",\"encoder\":\"none (plain frames)\",\"adapter\":\"%ls\",\"udpPort\":0}", OW, OH, adesc.Description);
  info(buf);
  std::thread(readCommands).detach();
  std::vector<uint8_t> pkt(8 + (size_t)OW * OH * 4);
  memcpy(&pkt[0], &OW, 4); memcpy(&pkt[4], &OH, 4);
  Cursor cursor; bool have = false, dirty = false; int lostTries = 0;
  auto nextDue = clk::now();
  while (!g_stop) {
    if (!dup) {
      Sleep(100);
      if (followInputDesktop()) { char d[64]; DWORD n = 0; wchar_t nm[32] = L""; GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, nm, sizeof nm, &n); snprintf(d, sizeof d, "{\"desktop\":\"%ls\"}", nm); info(d); }
      if (FAILED(out1->DuplicateOutput(dev, &dup))) { dup.Reset(); if (++lostTries > 50) quit(3, "capture lost"); continue; }
      DXGI_OUTDUPL_DESC d2; dup->GetDesc(&d2); if ((d2.ModeDesc.Width & ~1u) != W || (d2.ModeDesc.Height & ~1u) != H) quit(3, "display size changed");
      lostTries = 0; continue;
    }
    DXGI_OUTDUPL_FRAME_INFO fi; ComPtr<IDXGIResource> res;
    const HRESULT hr = dup->AcquireNextFrame(50, &fi, &res);
    if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) { dup.Reset(); continue; }   // desktop switch: follow it
    if (SUCCEEDED(hr)) {
      if (fi.LastPresentTime.QuadPart) { ComPtr<ID3D11Texture2D> tex; res.As(&tex); D3D11_BOX box = { 0, 0, 0, W, H, 1 }; ctx->CopySubresourceRegion(stage.Get(), 0, 0, 0, 0, tex.Get(), 0, &box); have = dirty = true; }
      if (fi.LastMouseUpdateTime.QuadPart) { cursor.pos = fi.PointerPosition.Position; cursor.visible = fi.PointerPosition.Visible; dirty = true; }
      if (fi.PointerShapeBufferSize) {
        cursor.shape.resize(fi.PointerShapeBufferSize); UINT got = 0;
        if (SUCCEEDED(dup->GetFramePointerShape(fi.PointerShapeBufferSize, cursor.shape.data(), &got, &cursor.si))) dirty = true;
      }
      dup->ReleaseFrame();
    } else if (hr != DXGI_ERROR_WAIT_TIMEOUT) quit(3, "capture failed");
    if (g_wantKey.exchange(false)) dirty = true;   // TryDesk asks for a picture now
    if (!dirty || !have || clk::now() < nextDue) continue;
    D3D11_MAPPED_SUBRESOURCE m; if (FAILED(ctx->Map(stage.Get(), 0, D3D11_MAP_READ, 0, &m))) continue;
    const double t = epochMs();
    uint8_t* o = pkt.data() + 8;
    for (UINT y = 0; y < OH; y++) {
      const uint8_t* src = (const uint8_t*)m.pData + (size_t)y * step * m.RowPitch;
      uint8_t* dst = o + (size_t)y * OW * 4;
      if (step == 1) memcpy(dst, src, (size_t)OW * 4);
      else for (UINT x = 0; x < OW; x++) memcpy(dst + (size_t)x * 4, src + (size_t)x * step * 4, 4);
    }
    ctx->Unmap(stage.Get(), 0);
    // The pointer, at its place in the (maybe halved) picture.
    const int cw = cursorWidth(cursor), ch = cursorHeight(cursor);
    if (cursor.visible && cw > 0 && ch > 0 && !cursor.shape.empty()) {
      const POINT real = cursor.pos; cursor.pos.x /= (LONG)step; cursor.pos.y /= (LONG)step;
      const int x0 = std::max<int>(0, cursor.pos.x), y0 = std::max<int>(0, cursor.pos.y);
      const int x1 = std::min<int>((int)OW, cursor.pos.x + cw), y1 = std::min<int>((int)OH, cursor.pos.y + ch);
      if (x1 > x0 && y1 > y0) blendCursor(cursor, o + ((size_t)y0 * OW + x0) * 4, OW * 4, x0, y0, x1 - x0, y1 - y0);
      cursor.pos = real;
    }
    writePacket(4, 0, t, pkt.data(), (uint32_t)pkt.size());
    dirty = false;
    nextDue = clk::now() + std::chrono::milliseconds(1000 / std::max(1, std::min(8, g_fps.load())));
  }
  return 0;
}

int main(int argc, char** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, nullptr, _IOFBF, 1 << 20);
  int rx = 0, ry = 0, rw = 0, rh = 0; bool recv = false, udp = false, loopback = false, wantHevc = false, rawOk = false, rawOnly = false, vm = false; int port = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--recv")) recv = true;
    else if (!strcmp(argv[i], "--raw-ok")) rawOk = true;
    else if (!strcmp(argv[i], "--raw-only")) rawOk = rawOnly = true;   // plain frames, no encoder and no video device
    else if (!strcmp(argv[i], "--vm")) vm = true;                       // see the adapter check below
    else if (!strcmp(argv[i], "--hevc")) wantHevc = true;
    else if (!strcmp(argv[i], "--loopback")) loopback = true;
    else if (!strcmp(argv[i], "--udp")) udp = true;
    else if (i + 1 >= argc) break;
    else if (!strcmp(argv[i], "--rect")) sscanf_s(argv[i + 1], "%d,%d,%d,%d", &rx, &ry, &rw, &rh);
    else if (!strcmp(argv[i], "--fps")) g_fps = std::max(1, std::min(240, atoi(argv[i + 1])));
    else if (!strcmp(argv[i], "--mbps")) g_mbps = std::max(1, std::min(1000, atoi(argv[i + 1])));
    else if (!strcmp(argv[i], "--port")) port = std::max(0, std::min(65535, atoi(argv[i + 1])));
  }
  if (recv) return runRecv((uint16_t)port);
  if (loopback) return runLoopback();
  // Real pixels for SetCursorPos (input commands come in physical desktop pixels, as --rect does).
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  followInputDesktop();   // started while a UAC prompt is up: capture that desktop
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) || FAILED(MFStartup(MF_VERSION))) quit(5, "com/mf startup");
  // 1 ms waits must really be 1 ms: with Windows' default 15.6 ms timer, the short waits between frames stretched and
  // held this at ~90 fps (measured). Applies to this process only, for as long as it runs (as games do).
  timeBeginPeriod(1);

  // 1. The output (monitor) whose desktop rectangle is --rect, and the adapter that drives it.
  ComPtr<IDXGIFactory1> factory; if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) quit(5, "dxgi factory");
  ComPtr<IDXGIAdapter1> adapter; ComPtr<IDXGIOutput> output; DXGI_OUTPUT_DESC od{};
  for (UINT a = 0; !output; a++) {
    ComPtr<IDXGIAdapter1> ad; if (factory->EnumAdapters1(a, &ad) == DXGI_ERROR_NOT_FOUND) break;
    for (UINT o = 0;; o++) {
      ComPtr<IDXGIOutput> out; if (ad->EnumOutputs(o, &out) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_OUTPUT_DESC d; out->GetDesc(&d); const RECT& r = d.DesktopCoordinates;
      const bool match = rw > 0 ? (r.left == rx && r.top == ry && r.right - r.left == rw && r.bottom - r.top == rh)
                                : (r.left == 0 && r.top == 0);   // no --rect: the primary monitor
      if (match && d.AttachedToDesktop) { adapter = ad; output = out; od = d; break; }
    }
  }
  // No exact match: TryDesk converts the screen's position from scaled to real pixels, and with monitors at different
  // scaling that can land a few pixels off. Take the monitor that covers most of the asked rectangle instead of
  // quitting (a quit here, with TryDesk run as administrator, used to leave the viewer without any picture).
  if (!output && rw > 0) {
    LONGLONG best = 0;
    for (UINT a = 0;; a++) {
      ComPtr<IDXGIAdapter1> ad; if (factory->EnumAdapters1(a, &ad) == DXGI_ERROR_NOT_FOUND) break;
      for (UINT o = 0;; o++) {
        ComPtr<IDXGIOutput> out; if (ad->EnumOutputs(o, &out) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_OUTPUT_DESC d; out->GetDesc(&d); if (!d.AttachedToDesktop) continue;
        const RECT& r = d.DesktopCoordinates;
        const LONGLONG w = (LONGLONG)std::min<LONG>(r.right, rx + rw) - std::max<LONG>(r.left, rx), h = (LONGLONG)std::min<LONG>(r.bottom, ry + rh) - std::max<LONG>(r.top, ry);
        if (w > 0 && h > 0 && w * h > best) { best = w * h; adapter = ad; output = out; od = d; }
      }
    }
  }
  if (!output) quit(2, "monitor not found");
  DXGI_ADAPTER_DESC1 adesc; adapter->GetDesc1(&adesc);
  // --vm (TryDesk runs in a Hyper-V guest, always with --raw-only): GPU-accelerated capture shared with Chromium's GPU
  // process took the whole VM down over GPU-PV. This path only copies the desktop to a CPU-readable texture in its own
  // process: Windows Sandbox with GPU-PV (NVIDIA through vrd.sys) stayed up through the lock-screen test, 17 Nov 2026.
  if (vm) { char d[200]; snprintf(d, sizeof d, "{\"vm\":\"plain frames only\",\"vendor\":%u}", adesc.VendorId); info(d); }

  // 2. D3D11 device on that adapter (video support for the colour conversion; multithread-protected: the encoder
  //    uses it from its own threads).
  ComPtr<ID3D11Device> dev; ComPtr<ID3D11DeviceContext> ctx;
  const bool nullAdapter = getenv("TDC_NULLADAPTER") != nullptr;   // diagnostics A/B
  bool noVideo = rawOnly;   // a display adapter without video support (Microsoft Basic Display): only plain frames (--raw-ok)
  if (rawOnly) { if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) quit(5, "d3d11 device"); }
  else if (FAILED(D3D11CreateDevice(nullAdapter ? nullptr : adapter.Get(), nullAdapter ? D3D_DRIVER_TYPE_HARDWARE : D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) {
    if (!rawOk || FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) quit(5, "d3d11 device");
    noVideo = true;
  }
  { ComPtr<ID3D11Multithread> mt; if (SUCCEEDED(ctx.As(&mt))) mt->SetMultithreadProtected(TRUE); }

  ComPtr<IDXGIOutput1> out1; output.As(&out1);
  ComPtr<IDXGIOutputDuplication> dup;
  // Can fail for a moment (desktop switch, an RDP session settling): a few tries before giving up.
  for (int i = 0; FAILED(out1->DuplicateOutput(dev.Get(), &dup)); i++) { dup.Reset(); if (i >= 9) quit(3, "duplicate output"); Sleep(200); }
  DXGI_OUTDUPL_DESC dd; dup->GetDesc(&dd);
  const UINT W = dd.ModeDesc.Width & ~1u, H = dd.ModeDesc.Height & ~1u;   // NV12/H.264 need even sizes
  if (noVideo || (rawOk && getenv("TDC_FORCERAW"))) return runRaw(dev.Get(), ctx.Get(), out1.Get(), dup, W, H, adesc);   // (TDC_FORCERAW: tests)

  // 3. Hardware encoder on the same adapter: H.265 (HEVC) when asked (--hevc) and the GPU has one, else H.264. The
  //    viewer reads which from the keyframe's parameter sets (and "codec" in the info packet). H.265 carries the same
  //    picture in fewer bits: sharper text and edges at the same rate (owner 17 Nov: "H.265 tidak ada bedanya").
  ComPtr<IMFTransform> enc; std::wstring encName; ComPtr<ICodecAPI> api; ComPtr<IMFDXGIDeviceManager> dm; bool hevc = false;
  auto setU4 = [&](const GUID& g, ULONG v) { if (!api) return; VARIANT x; VariantInit(&x); x.vt = VT_UI4; x.ulVal = v; api->SetValue(&g, &x); };
  const char* failed = nullptr;
  auto makeEncoder = [&](bool h265) -> bool {
    enc.Reset(); api.Reset(); dm.Reset(); encName.clear();
    // H.264 hardware encoders stop at 4096; H.265 ones take up to 8192.
    if (W > (h265 ? 8192u : 4096u) || H > (h265 ? 8192u : 4096u)) { failed = "resolution above what the hardware encoder takes"; return false; }
    const GUID fmt = h265 ? MFVideoFormat_HEVC : MFVideoFormat_H264;
    MFT_REGISTER_TYPE_INFO outInfo = { MFMediaType_Video, fmt };
    ComPtr<IMFAttributes> want; MFCreateAttributes(&want, 1); want->SetBlob(MFT_ENUM_ADAPTER_LUID, (const UINT8*)&adesc.AdapterLuid, sizeof(LUID));
    IMFActivate** acts = nullptr; UINT32 n = 0;
    const bool enumEx = getenv("TDC_ENUMEX") != nullptr;   // diagnostics A/B
    HRESULT he = enumEx ? MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &outInfo, &acts, &n)
                        : MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &outInfo, want.Get(), &acts, &n);
    if (FAILED(he) || !n) { failed = h265 ? "no hardware H.265 encoder on this GPU" : "no hardware H.264 encoder on this GPU"; return false; }
    wchar_t* name = nullptr; UINT32 nl = 0; if (SUCCEEDED(acts[0]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &name, &nl))) { encName = name; CoTaskMemFree(name); }
    HRESULT hr = acts[0]->ActivateObject(IID_PPV_ARGS(&enc));
    for (UINT32 i = 0; i < n; i++) acts[i]->Release(); CoTaskMemFree(acts);
    if (FAILED(hr)) { failed = "encoder activate"; return false; }
    ComPtr<IMFAttributes> ea; enc->GetAttributes(&ea);
    if (ea) { ea->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE); ea->SetUINT32(MF_LOW_LATENCY, TRUE); }
    UINT resetToken;
    if (FAILED(MFCreateDXGIDeviceManager(&resetToken, &dm)) || FAILED(dm->ResetDevice(dev.Get(), resetToken)) ||
        FAILED(enc->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(dm.Get())))) { failed = "encoder d3d manager"; return false; }
    enc.As(&api);
    if (api) { VARIANT x; VariantInit(&x); x.vt = VT_BOOL; x.boolVal = VARIANT_TRUE; api->SetValue(&CODECAPI_AVLowLatencyMode, &x); }
    setU4(CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
    setU4(CODECAPI_AVEncCommonMeanBitRate, (ULONG)g_mbps * 1000000);
    setU4(CODECAPI_AVEncMPVDefaultBPictureCount, 0);
    setU4(CODECAPI_AVEncMPVGOPSize, 240 * 4);   // a keyframe every ~4 s of motion; the viewer asks for one after a loss
    // What the picture is (BT.709, studio range 16-235, the range the video processor below writes): the stream's
    // colour info then matches the pixels, and the viewer's decoder doesn't stretch them.
    auto colour = [](IMFMediaType* t) {
      t->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235); t->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
      t->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709); t->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    };
    auto setTypes = [&](bool withColour) {
      ComPtr<IMFMediaType> ot; MFCreateMediaType(&ot);
      ot->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); ot->SetGUID(MF_MT_SUBTYPE, fmt);
      ot->SetUINT32(MF_MT_AVG_BITRATE, g_mbps * 1000000); MFSetAttributeSize(ot.Get(), MF_MT_FRAME_SIZE, W, H);
      MFSetAttributeRatio(ot.Get(), MF_MT_FRAME_RATE, 240, 1); ot->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
      ot->SetUINT32(MF_MT_MPEG2_PROFILE, h265 ? (UINT32)eAVEncH265VProfile_Main_420_8 : (UINT32)eAVEncH264VProfile_High);
      if (withColour) colour(ot.Get());
      if (FAILED(enc->SetOutputType(0, ot.Get(), 0))) { failed = "encoder output type"; return false; }
      ComPtr<IMFMediaType> it; MFCreateMediaType(&it);
      it->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); it->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
      MFSetAttributeSize(it.Get(), MF_MT_FRAME_SIZE, W, H); MFSetAttributeRatio(it.Get(), MF_MT_FRAME_RATE, 240, 1);
      it->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
      if (withColour) colour(it.Get());
      if (FAILED(enc->SetInputType(0, it.Get(), 0))) { failed = "encoder input type"; return false; }
      return true;
    };
    // An encoder that refuses the colour info gets the types without it (the 1.3.9 stream) instead of exit 4: that
    // counts as "no H.264 encoder", and a host running as administrator has no other picture.
    if (!setTypes(true)) {
      info("{\"colour\":\"encoder refused the colour info, sent without it\"}");
      if (!setTypes(false)) return false;
    }
    ComPtr<IMFMediaEventGenerator> ev; if (FAILED(enc.As(&ev))) { failed = "encoder is not asynchronous"; return false; }
    return true;
  };
  if (wantHevc && makeEncoder(true)) hevc = true;
  else {
    if (wantHevc) info(std::string("{\"codec\":\"h264\",\"why\":\"") + (failed ? failed : "?") + "\"}");   // asked for H.265, sending H.264
    if (!makeEncoder(false)) {
      if (rawOk) { info(std::string("{\"raw\":\"") + (failed ? failed : "encoder setup") + "\"}"); enc.Reset(); api.Reset(); dm.Reset(); return runRaw(dev.Get(), ctx.Get(), out1.Get(), dup, W, H, adesc); }
      quit(4, failed ? failed : "encoder setup");
    }
  }
  ComPtr<IMFMediaEventGenerator> events; if (FAILED(enc.As(&events))) quit(4, "encoder is not asynchronous");
  enc->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  enc->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  enc->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

  // 4. GPU surfaces: the clean desktop copy, the frame with the cursor drawn in, a staging patch for the cursor,
  //    and a small ring of NV12 surfaces the encoder reads from.
  ComPtr<ID3D11VideoDevice> vdev; dev.As(&vdev); ComPtr<ID3D11VideoContext> vctx; ctx.As(&vctx);
  if (!vdev || !vctx) quit(5, "video device");
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd = { D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, { 240, 1 }, W, H, { 240, 1 }, W, H, D3D11_VIDEO_USAGE_OPTIMAL_SPEED };
  ComPtr<ID3D11VideoProcessorEnumerator> venum; ComPtr<ID3D11VideoProcessor> vproc;
  if (FAILED(vdev->CreateVideoProcessorEnumerator(&cd, &venum)) || FAILED(vdev->CreateVideoProcessor(venum.Get(), 0, &vproc))) quit(5, "video processor");
  // The desktop is full-range RGB; the NV12 for the encoder must be studio range (16-235) BT.709, which is what an H.264
  // decoder assumes. Left to the driver it was full-range YUV and the viewer stretched it: dark grey 30 arrived as 16,
  // text edges harsh, measured 31.9 dB instead of 40.2 dB on black text and 25.4 instead of 45.4 on code (14 Nov 2026).
  {
    // The newer call only for a pair this driver says it converts (an unsupported pair makes every Blt below fail
    // without a word: no picture at all); otherwise the older description, which every video processor takes.
    ComPtr<ID3D11VideoContext1> vctx1; ComPtr<ID3D11VideoProcessorEnumerator1> venum1; BOOL pairOk = FALSE;
    if (SUCCEEDED(venum.As(&venum1)))
      venum1->CheckVideoProcessorFormatConversion(DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
                                                  DXGI_FORMAT_NV12, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, &pairOk);
    if (pairOk && SUCCEEDED(vctx.As(&vctx1))) {
      vctx1->VideoProcessorSetStreamColorSpace1(vproc.Get(), 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
      vctx1->VideoProcessorSetOutputColorSpace1(vproc.Get(), DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
    } else {
      D3D11_VIDEO_PROCESSOR_COLOR_SPACE in = {}, out = {};
      in.RGB_Range = 0;                                                 // full 0-255
      out.YCbCr_Matrix = 1; out.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;   // BT.709, studio range
      vctx->VideoProcessorSetStreamColorSpace(vproc.Get(), 0, &in); vctx->VideoProcessorSetOutputColorSpace(vproc.Get(), &out);
    }
  }
  D3D11_TEXTURE2D_DESC td = {}; td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  ComPtr<ID3D11Texture2D> clean, frame;
  td.BindFlags = 0; if (FAILED(dev->CreateTexture2D(&td, nullptr, &clean))) quit(5, "texture");
  td.BindFlags = D3D11_BIND_RENDER_TARGET; if (FAILED(dev->CreateTexture2D(&td, nullptr, &frame))) quit(5, "texture");
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd = { 0, D3D11_VPIV_DIMENSION_TEXTURE2D, { 0, 0 } };
  ComPtr<ID3D11VideoProcessorInputView> inView; if (FAILED(vdev->CreateVideoProcessorInputView(frame.Get(), venum.Get(), &ivd, &inView))) quit(5, "input view");
  const int RING = 4; std::vector<ComPtr<ID3D11Texture2D>> nv12(RING); std::vector<ComPtr<ID3D11VideoProcessorOutputView>> outViews(RING);
  for (int i = 0; i < RING; i++) {
    D3D11_TEXTURE2D_DESC nd = td; nd.Format = DXGI_FORMAT_NV12; nd.BindFlags = D3D11_BIND_RENDER_TARGET;
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd = { D3D11_VPOV_DIMENSION_TEXTURE2D };
    if (FAILED(dev->CreateTexture2D(&nd, nullptr, &nv12[i])) || FAILED(vdev->CreateVideoProcessorOutputView(nv12[i].Get(), venum.Get(), &ovd, &outViews[i]))) quit(5, "nv12 surface");
  }
  const UINT CUR = 256;   // largest pointer patch handled (Windows pointers are at most 256 px)
  D3D11_TEXTURE2D_DESC sd = {}; sd.Width = CUR; sd.Height = CUR; sd.MipLevels = 1; sd.ArraySize = 1; sd.SampleDesc.Count = 1; sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> curStage; if (FAILED(dev->CreateTexture2D(&sd, nullptr, &curStage))) quit(5, "cursor staging");

  char buf[512];
  if (udp && !g_link.open((uint16_t)port, 0)) { udp = false; info("{\"udp\":\"no socket\"}"); }
  snprintf(buf, sizeof buf, "{\"w\":%u,\"h\":%u,\"refresh\":%u,\"codec\":\"%s\",\"encoder\":\"%ls\",\"adapter\":\"%ls\",\"udpPort\":%u}", W, H,
           dd.ModeDesc.RefreshRate.Numerator / std::max(1u, dd.ModeDesc.RefreshRate.Denominator), hevc ? "hevc" : "h264", encName.c_str(), adesc.Description, udp ? g_link.port() : 0u);
  info(buf);
  if (udp) {
    g_sender = new tdudp::Sender(g_link);   // lives as long as the process
    g_sender->start([] { g_wantKey = true; }, [](bool up) { info(up ? "{\"udp\":\"up\",\"peer\":\"" + g_link.peerText() + "\"}" : "{\"udp\":\"lost\"}"); });
  }
  std::thread(readCommands).detach();

  // 5. Capture loop. Encoded output goes to stdout from the encoder's own thread (EncoderEvents).
  EncoderEvents* encEvents = new EncoderEvents(enc.Get(), events.Get());   // lives as long as the process
  encEvents->start();
  Cursor cursor; bool haveDesktop = false, dirty = false;
  int ring = 0; long long ts100ns = 0;
  // The hardware encoders (NVIDIA's MFT, measured 17 Nov 2026, H.264 and H.265 alike) hand a frame out only when the
  // NEXT one goes in. On a busy screen that is a few ms; after a single change (a key press, a click, a caret) the
  // picture waited for the next change: 50-140 ms, and the viewer read that wait as a queue on the link and cut the
  // rate. So each real frame is followed by a copy of itself ("flush") as soon as the encoder takes input: it pushes
  // the real one out at once (capture -> out at most 3-5 ms instead of 35-137, measured) and costs ~4-5 KB at 1080p.
  // Its own output waits for the next real frame, which doesn't matter: it shows the same picture. It goes out with
  // capture time 0, which tells the viewer not to measure it (fastQueueNote) nor show it. TDC_NOFLUSH=1 turns this off.
  static const bool noFlush = getenv("TDC_NOFLUSH") != nullptr;
  bool flushArmed = false; int flushRing = 0;
  // (Tried 17 Nov: more copies of a still picture to sharpen it. NVIDIA's encoder sends them as empty frames, the
  // picture stays as sharp as its first frame: measured 35.41 dB before and after at 40 Mbps. Not kept.)
  auto submitSample = [&](int r, double capturedAt) -> bool {
    ComPtr<IMFMediaBuffer> mb; ComPtr<IMFSample> s;
    if (FAILED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), nv12[r].Get(), 0, FALSE, &mb)) || FAILED(MFCreateSample(&s))) return false;
    s->AddBuffer(mb.Get());
    const LONGLONG dur = 10000000LL / g_fps; s->SetSampleTime(ts100ns); s->SetSampleDuration(dur); ts100ns += dur;
    encEvents->submitted(capturedAt);
    if (SUCCEEDED(enc->ProcessInput(0, s.Get(), 0))) { encEvents->needInput--; return true; }
    encEvents->unsubmitted(); return false;
  };
  auto nextDue = clk::now();
  int lostTries = 0;
  // TDC_DEBUG=1: one info packet a second with what limited the rate (diagnostics only).
  const bool dbg = getenv("TDC_DEBUG") != nullptr; auto dbgAt = clk::now();
  int dDesk = 0, dSubmit = 0, dBusy = 0, dEarly = 0;
  auto dropsAt = clk::now();
  while (!g_stop) {
    if (dbg && clk::now() - dbgAt >= std::chrono::seconds(1)) {
      char d[200]; snprintf(d, sizeof d, "{\"desktop\":%d,\"submitted\":%d,\"encoderBusy\":%d,\"notDue\":%d,\"out\":%d}", dDesk, dSubmit, dBusy, dEarly, encEvents->outCount.exchange(0));
      info(d); dDesk = dSubmit = dBusy = dEarly = 0; dbgAt = clk::now();
    }
    // Frames the UDP sender had to drop (its queue was full): TryDesk lowers the bitrate on these.
    if (g_sender && clk::now() - dropsAt >= std::chrono::seconds(1)) { dropsAt = clk::now(); const int n = g_sender->takeDrops(); if (n) info("{\"udpDrops\":" + std::to_string(n) + "}"); }
    if (g_rateChanged.exchange(false)) setU4(CODECAPI_AVEncCommonMeanBitRate, (ULONG)g_mbps * 1000000);
    // A frame is waiting and only the encoder isn't ready: sleep until it says it is (woken at once, no polling).
    if ((dirty || g_wantKey || flushArmed) && haveDesktop && encEvents->needInput <= 0) { if (dbg) dBusy++; WaitForSingleObject(encEvents->needEvent, 8); }
    // Nothing to send: block until the desktop changes (up to 16 ms, then look at the commands again).
    // Something to send: wait only until it is due.
    const auto now = clk::now();
    UINT waitMs = 16;
    // (rounded UP to whole ms: rounding down to 0 made this spin tens of thousands of times a second, measured)
    auto msUntil = [&](clk::time_point t) { return now < t ? (UINT)((std::chrono::duration_cast<std::chrono::microseconds>(t - now).count() + 999) / 1000) : 0u; };
    if (dirty || g_wantKey) waitMs = msUntil(nextDue);
    if (flushArmed) waitMs = 0;   // the flush copy goes in as soon as the encoder takes it (below)
    // Capture was lost (below): get it back before touching it again. A failed DuplicateOutput leaves dup empty,
    // and calling AcquireNextFrame on it crashed the helper (0xC0000005, an RDP PC whose resolution changed).
    if (!dup) {
      Sleep(100);
      // The input desktop may have changed (UAC prompt up or gone): duplicate the one that is shown now.
      if (followInputDesktop()) { char d[64]; DWORD n = 0; wchar_t nm[32] = L""; GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, nm, sizeof nm, &n); snprintf(d, sizeof d, "{\"desktop\":\"%ls\"}", nm); info(d); }
      if (FAILED(out1->DuplicateOutput(dev.Get(), &dup))) { dup.Reset(); if (++lostTries > 50) quit(3, "capture lost"); continue; }
      DXGI_OUTDUPL_DESC d2; dup->GetDesc(&d2); if ((d2.ModeDesc.Width & ~1u) != W || (d2.ModeDesc.Height & ~1u) != H) quit(3, "display size changed");
      lostTries = 0; continue;
    }
    DXGI_OUTDUPL_FRAME_INFO fi; ComPtr<IDXGIResource> res;
    HRESULT hr = dup->AcquireNextFrame(std::min<UINT>(waitMs, 16), &fi, &res);
    if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
      // Display mode change, desktop switch (UAC prompt, lock screen) or another full-screen app: try to come back.
      dup.Reset(); continue;
    }
    if (SUCCEEDED(hr)) {
      if (fi.LastPresentTime.QuadPart) { ComPtr<ID3D11Texture2D> tex; res.As(&tex); D3D11_BOX box = { 0, 0, 0, W, H, 1 }; ctx->CopySubresourceRegion(clean.Get(), 0, 0, 0, 0, tex.Get(), 0, &box); haveDesktop = dirty = true; dDesk++; }
      if (fi.LastMouseUpdateTime.QuadPart) { cursor.pos = fi.PointerPosition.Position; cursor.visible = fi.PointerPosition.Visible; dirty = true; }
      if (fi.PointerShapeBufferSize) {
        cursor.shape.resize(fi.PointerShapeBufferSize); UINT got = 0;
        if (SUCCEEDED(dup->GetFramePointerShape(fi.PointerShapeBufferSize, cursor.shape.data(), &got, &cursor.si))) dirty = true;
      }
      dup->ReleaseFrame();
    } else if (hr != DXGI_ERROR_WAIT_TIMEOUT) quit(3, "capture failed");

    const bool keyNow = g_wantKey.load();
    if (dbg && (dirty || keyNow) && haveDesktop && encEvents->needInput > 0 && clk::now() < nextDue) dEarly++;
    if ((dirty || keyNow) && haveDesktop && encEvents->needInput > 0 && clk::now() >= nextDue) {
      dSubmit++;
      const double capturedAt = epochMs();
      ctx->CopyResource(frame.Get(), clean.Get());
      // Draw the pointer: read back its patch, blend on the CPU, write it back.
      const int cw = std::min<int>(cursorWidth(cursor), CUR), ch = std::min<int>(cursorHeight(cursor), CUR);
      static const bool noCursor = getenv("TDC_NOCURSOR") != nullptr;   // diagnostics only
      if (!noCursor && cursor.visible && cw > 0 && ch > 0 && !cursor.shape.empty()) {
        const int x0 = std::max<int>(0, cursor.pos.x), y0 = std::max<int>(0, cursor.pos.y);
        const int x1 = std::min<int>((int)W, cursor.pos.x + cw), y1 = std::min<int>((int)H, cursor.pos.y + ch);
        if (x1 > x0 && y1 > y0) {
          D3D11_BOX box = { (UINT)x0, (UINT)y0, 0, (UINT)x1, (UINT)y1, 1 };
          ctx->CopySubresourceRegion(curStage.Get(), 0, 0, 0, 0, clean.Get(), 0, &box);
          D3D11_MAPPED_SUBRESOURCE m;
          if (SUCCEEDED(ctx->Map(curStage.Get(), 0, D3D11_MAP_READ, 0, &m))) {
            std::vector<uint8_t> patch((size_t)(x1 - x0) * (y1 - y0) * 4);
            for (int y = 0; y < y1 - y0; y++) memcpy(&patch[(size_t)y * (x1 - x0) * 4], (uint8_t*)m.pData + y * m.RowPitch, (size_t)(x1 - x0) * 4);
            ctx->Unmap(curStage.Get(), 0);
            blendCursor(cursor, patch.data(), (x1 - x0) * 4, x0, y0, x1 - x0, y1 - y0);
            ctx->UpdateSubresource(frame.Get(), 0, &box, patch.data(), (x1 - x0) * 4, 0);
          }
        }
      }
      D3D11_VIDEO_PROCESSOR_STREAM stream = {}; stream.Enable = TRUE; stream.pInputSurface = inView.Get();
      if (SUCCEEDED(vctx->VideoProcessorBlt(vproc.Get(), outViews[ring].Get(), 0, 1, &stream))) {
        if (keyNow) { setU4(CODECAPI_AVEncVideoForceKeyFrame, 1); g_wantKey = false; }
        if (submitSample(ring, capturedAt)) { dirty = false; flushArmed = !noFlush; flushRing = ring; ring = (ring + 1) % RING; }
      }
      // A fixed cadence (due += period), not "now + period": the time spent per frame must not add up (it held
      // 240 fps down to ~135, measured). After a quiet spell, restart the cadence from now.
      const auto period = std::chrono::nanoseconds(1000000000LL / g_fps);
      nextDue += period; if (nextDue < clk::now() - period) nextDue = clk::now();
    } else if (flushArmed && haveDesktop && encEvents->needInput > 0) {
      // No real frame to send right now: the flush copy of the last one (same surface, nothing changed).
      if (submitSample(flushRing, 0.0)) flushArmed = false;
    }
  }
  quit(0, "stopped");
}
