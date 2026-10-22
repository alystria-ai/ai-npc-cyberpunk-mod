/*
 * AI NPC Cyberpunk Mod vision helper: takes one still picture of the Cyberpunk 2077 window, on request, for
 * "Companions can see" (docs/COMPANION_VISION.md).
 *
 * Out of process and on demand. The game is never touched: no injection, no hook, no game-thread work. A capture
 * takes one frame, closes its session at once, scales it down and encodes a JPEG in memory. Nothing is written to
 * disk. Two ways to take the frame:
 *   wgc   a Windows Graphics Capture session on the game's own window (never a monitor, so other windows and the
 *         desktop can never appear). Windows draws a yellow border around a captured window; it is left out only for
 *         a packaged app that was granted borderless access, which this plain exe cannot be (see borderlessGranted).
 *   dxgi  Desktop Duplication of the monitor the game is on, cropped to the game's client area: no border. It sees
 *         the whole monitor, so it is only taken while the game is in front and nothing clickable covers it
 *         (coveredByOther), else the reply is "covered".
 *
 * Protocol: one request per stdin line, one JSON reply per stdout line, in order.
 *   ready line, once: {"ready":true,"build":W,"wgc":bool,"borderless":bool}
 *   capture <maxWidth 64..2048> <quality 1..100> [wgc|dxgi|auto]     (default wgc; auto: borderless wgc, else dxgi, else wgc)
 *     -> {"ok":true,"width":W,"height":H,"sourceWidth":SW,"sourceHeight":SH,"bytes":N,"method":"wgc|dxgi","border":bool,
 *         "ms":{"find":..,"frame":..,"copy":..,"encode":..,"total":..,"cpu":..},"jpeg":"<base64>"}
 *     -> {"ok":false,"reason":"no-window|minimised|unsupported|no-frame|failed|covered|dxgi-unavailable","ms":{"total":..}}
 *   quit
 * End of stdin also quits, so the helper never outlives the bridge. While idle it is blocked on a read: no
 * capture session exists between requests, so it costs the game nothing.
 *
 * The window is found by its owning executable's file name (Cyberpunk2077.exe): a visible, unowned top-level
 * window, the largest if there are several. The image name is checked again before every capture.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <appmodel.h>
#include <wincodec.h>
#include <shlwapi.h>
#include <inspectable.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

using namespace winrt;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

static const wchar_t *GAME_EXE = L"Cyberpunk2077.exe";   // `--exe` replaces it (development)
static bool g_wgcSupported = false;
static bool g_borderless = false;
static bool g_dxgiBroken = false;   // Desktop Duplication could not be made on this system (see capture)
static unsigned g_build = 0;
static const DWORD FRAME_WAIT_MS = 600;

struct Clock {
    std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
    double ms() const { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count(); }
};

// This process's CPU time (user + kernel), in milliseconds: each reply reports what its capture cost.
static double cpuMs() {
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return 0;
    auto value = [](const FILETIME &time) { return ((unsigned long long)time.dwHighDateTime << 32 | time.dwLowDateTime) / 10000.0; };
    return value(kernel) + value(user);
}

static bool ownedByGame(HWND hwnd) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid) return false;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    wchar_t path[MAX_PATH * 4];
    DWORD size = (DWORD)(sizeof(path) / sizeof(path[0]));
    bool ok = QueryFullProcessImageNameW(process, 0, path, &size) != 0;
    CloseHandle(process);
    if (!ok) return false;
    const wchar_t *name = wcsrchr(path, L'\\');
    name = name ? name + 1 : path;
    return _wcsicmp(name, GAME_EXE) == 0;
}

static bool candidate(HWND hwnd) {
    if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return false;
    BOOL cloaked = FALSE;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return false;
    return ownedByGame(hwnd);
}

struct Search { HWND best = nullptr; long long area = -1; };

static BOOL CALLBACK visit(HWND hwnd, LPARAM data) {
    if (!candidate(hwnd)) return TRUE;
    RECT rect{};
    GetWindowRect(hwnd, &rect);
    long long area = (long long)(rect.right - rect.left) * (rect.bottom - rect.top);
    Search *search = reinterpret_cast<Search *>(data);
    if (area > search->area) { search->best = hwnd; search->area = area; }
    return TRUE;
}

static HWND gameWindow(HWND cached) {
    if (cached && IsWindow(cached) && candidate(cached)) return cached;
    Search search;
    EnumWindows(visit, reinterpret_cast<LPARAM>(&search));
    return search.best;
}

static std::string base64(const unsigned char *data, size_t size) {
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3) {
        unsigned value = data[i] << 16 | (i + 1 < size ? data[i + 1] << 8 : 0) | (i + 2 < size ? data[i + 2] : 0);
        out += table[(value >> 18) & 63];
        out += table[(value >> 12) & 63];
        out += i + 1 < size ? table[(value >> 6) & 63] : '=';
        out += i + 2 < size ? table[value & 63] : '=';
    }
    return out;
}

struct Device {
    com_ptr<ID3D11Device> d3d;
    com_ptr<ID3D11DeviceContext> context;
    wgd3d::IDirect3DDevice winrt{nullptr};
    com_ptr<IWICImagingFactory> wic;
};

static bool createDevice(Device &device) {
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0, D3D11_SDK_VERSION,
            device.d3d.put(), nullptr, device.context.put()))) return false;
    com_ptr<IDXGIDevice> dxgi = device.d3d.as<IDXGIDevice>();
    com_ptr<::IInspectable> inspectable;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()))) return false;
    device.winrt = inspectable.as<wgd3d::IDirect3DDevice>();
    return SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(device.wic.put())));
}

static void reply(const std::string &line) {
    fwrite(line.data(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static std::string number(double value) {
    char buffer[32];
    snprintf(buffer, sizeof(buffer), "%.1f", value);
    return buffer;
}

static std::string failure(const char *reason, const Clock &clock) {
    return std::string("{\"ok\":false,\"reason\":\"") + reason + "\",\"ms\":{\"total\":" + number(clock.ms()) + "}}";
}

// What the capture methods hand to the encoder: the pixels (BGRA, the game's client area only) and where they are.
struct Pixels {
    const BYTE *data = nullptr;
    UINT rowPitch = 0, width = 0, height = 0;
};

// Scales to maxWidth with WIC Fant and encodes a JPEG in memory. False when any step fails.
static bool encodeJpeg(Device &device, const Pixels &source, UINT maxWidth, UINT quality, std::vector<unsigned char> &jpeg, UINT &width, UINT &height) {
    width = std::min(maxWidth, source.width);
    height = std::max<UINT>(1, (UINT)((double)source.height * width / source.width + 0.5));
    com_ptr<IWICBitmap> bitmap;
    com_ptr<IWICBitmapScaler> scaler;
    com_ptr<IStream> stream;
    com_ptr<IWICBitmapEncoder> encoder;
    com_ptr<IWICBitmapFrameEncode> target;
    com_ptr<IPropertyBag2> options;
    // The game draws opaque pixels; BGRX keeps a stray alpha channel out of the picture.
    if (FAILED(device.wic->CreateBitmapFromMemory(source.width, source.height, GUID_WICPixelFormat32bppBGR,
            source.rowPitch, source.rowPitch * (source.height - 1) + source.width * 4, const_cast<BYTE *>(source.data), bitmap.put()))
        || FAILED(device.wic->CreateBitmapScaler(scaler.put()))
        || FAILED(scaler->Initialize(bitmap.get(), width, height, WICBitmapInterpolationModeFant))
        || FAILED(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()))
        || FAILED(device.wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put()))
        || FAILED(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache))
        || FAILED(encoder->CreateNewFrame(target.put(), options.put()))) return false;
    PROPBAG2 option{};
    wchar_t name[] = L"ImageQuality";
    option.pstrName = name;
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = quality / 100.0f;
    options->Write(1, &option, &value);
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    if (FAILED(target->Initialize(options.get())) || FAILED(target->SetSize(width, height))
        || FAILED(target->SetPixelFormat(&format)) || FAILED(target->WriteSource(scaler.get(), nullptr))
        || FAILED(target->Commit()) || FAILED(encoder->Commit())) return false;
    HGLOBAL global = nullptr;
    if (FAILED(GetHGlobalFromStream(stream.get(), &global))) return false;
    STATSTG stat{};
    stream->Stat(&stat, STATFLAG_NONAME);
    const unsigned char *bytes = static_cast<const unsigned char *>(GlobalLock(global));
    if (!bytes) return false;
    jpeg.assign(bytes, bytes + (size_t)stat.cbSize.QuadPart);
    GlobalUnlock(global);
    return !jpeg.empty();
}

struct Timing { double find = 0, frame = 0, copy = 0; };

static std::string success(const std::vector<unsigned char> &jpeg, UINT width, UINT height, UINT sourceWidth, UINT sourceHeight,
    const Timing &timing, double encodeMs, double cpuStart, const char *method, bool border) {
    return "{\"ok\":true,\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height)
        + ",\"sourceWidth\":" + std::to_string(sourceWidth) + ",\"sourceHeight\":" + std::to_string(sourceHeight)
        + ",\"bytes\":" + std::to_string(jpeg.size())
        + ",\"method\":\"" + method + "\",\"border\":" + (border ? "true" : "false")
        + ",\"ms\":{\"find\":" + number(timing.find) + ",\"frame\":" + number(timing.frame - timing.find)
        + ",\"copy\":" + number(timing.copy - timing.frame) + ",\"encode\":" + number(encodeMs - timing.copy)
        + ",\"total\":" + number(encodeMs) + ",\"cpu\":" + number(cpuMs() - cpuStart) + "},\"jpeg\":\"" + base64(jpeg.data(), jpeg.size()) + "\"}";
}

// ---- Windows Graphics Capture ----------------------------------------------------------------------------------------------
// One still picture of the game window, or a failure reason. The capture session lives only until the first frame. Windows draws a yellow border
// around a window that is being captured; it is only left out for a packaged app that was granted borderless access (`g_borderless`), so
// this path shows it for every capture the bridge asks for.
static std::string captureWgc(Device &device, HWND &cached, UINT maxWidth, UINT quality) {
    Clock clock;
    double cpuStart = cpuMs();
    if (!g_wgcSupported) return failure("unsupported", clock);
    HWND hwnd = gameWindow(cached);
    cached = hwnd;
    if (!hwnd) return failure("no-window", clock);
    if (IsIconic(hwnd)) return failure("minimised", clock);
    Timing timing;
    timing.find = clock.ms();

    auto interop = get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    wgc::GraphicsCaptureItem item{nullptr};
    if (FAILED(interop->CreateForWindow(hwnd, guid_of<wgc::GraphicsCaptureItem>(), put_abi(item))) || !item)
        return failure("failed", clock);
    auto size = item.Size();
    if (size.Width <= 0 || size.Height <= 0) return failure("no-frame", clock);

    auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(device.winrt,
        wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size);
    auto session = pool.CreateCaptureSession(item);
    // Never draw the cursor. The border is asked to be left out, which only takes effect with borderless access (see above).
    try { session.IsCursorCaptureEnabled(false); } catch (...) {}
    if (g_borderless) { try { session.IsBorderRequired(false); } catch (...) {} }
    HANDLE arrived = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    auto token = pool.FrameArrived([arrived](auto &&, auto &&) { SetEvent(arrived); });
    session.StartCapture();
    DWORD waited = WaitForSingleObject(arrived, FRAME_WAIT_MS);
    wgc::Direct3D11CaptureFrame frame{nullptr};
    if (waited == WAIT_OBJECT_0) frame = pool.TryGetNextFrame();
    timing.frame = clock.ms();

    com_ptr<ID3D11Texture2D> staging;
    UINT sourceWidth = 0, sourceHeight = 0;
    if (frame) {
        auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        com_ptr<ID3D11Texture2D> texture;
        access->GetInterface(guid_of<ID3D11Texture2D>(), texture.put_void());
        D3D11_TEXTURE2D_DESC desc{};
        texture->GetDesc(&desc);
        auto content = frame.ContentSize();
        sourceWidth = (UINT)std::min<int>(content.Width, (int)desc.Width);
        sourceHeight = (UINT)std::min<int>(content.Height, (int)desc.Height);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        desc.MiscFlags = 0;
        if (SUCCEEDED(device.d3d->CreateTexture2D(&desc, nullptr, staging.put())))
            device.context->CopyResource(staging.get(), texture.get());
        frame.Close();
    }
    // The session ends before any encoding: the game window is captured for one frame only.
    pool.FrameArrived(token);
    session.Close();
    pool.Close();
    CloseHandle(arrived);
    if (!staging || !sourceWidth || !sourceHeight) return failure("no-frame", clock);

    // Only the game's picture: a windowed game's title bar and frame are cropped away. The captured surface starts at
    // the window's visible frame bounds; the client area is the game's own drawing.
    UINT cropX = 0, cropY = 0;
    {
        RECT frameBounds{}, client{};
        POINT origin{0, 0};
        if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &frameBounds, sizeof(frameBounds)))
            && GetClientRect(hwnd, &client) && ClientToScreen(hwnd, &origin)) {
            long x = origin.x - frameBounds.left, y = origin.y - frameBounds.top;
            long w = client.right - client.left, h = client.bottom - client.top;
            if (x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= (long)sourceWidth && y + h <= (long)sourceHeight) {
                cropX = (UINT)x; cropY = (UINT)y; sourceWidth = (UINT)w; sourceHeight = (UINT)h;
            }
        }
    }
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(device.context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return failure("failed", clock);
    timing.copy = clock.ms();
    Pixels pixels{static_cast<const BYTE *>(mapped.pData) + (size_t)cropY * mapped.RowPitch + (size_t)cropX * 4, mapped.RowPitch, sourceWidth, sourceHeight};
    std::vector<unsigned char> jpeg;
    UINT width = 0, height = 0;
    bool encoded = encodeJpeg(device, pixels, maxWidth, quality, jpeg, width, height);
    device.context->Unmap(staging.get(), 0);
    if (!encoded) return failure("failed", clock);
    return success(jpeg, width, height, sourceWidth, sourceHeight, timing, clock.ms(), cpuStart, "wgc", !g_borderless);
}

// ---- Desktop Duplication (no capture border) -------------------------------------------------------------------------------
// Duplicates the monitor the game is on and crops to the game's client area: no yellow border and no consent prompt. It sees the whole monitor,
// so it is only used while the game window is in front and no visible, clickable window covers any part of its client area (an overlay that
// is click-through, such as a frame counter, is part of what the player sees and does not count). Otherwise "covered": no picture.
static bool isTaskbar(HWND hwnd) {
    wchar_t name[64];
    return GetClassNameW(hwnd, name, 64) > 0 && (wcscmp(name, L"Shell_TrayWnd") == 0 || wcscmp(name, L"Shell_SecondaryTrayWnd") == 0);
}

static bool coveredByOther(HWND game, const RECT &area) {
    if (GetAncestor(GetForegroundWindow(), GA_ROOT) != game) return true;
    for (HWND other = GetTopWindow(nullptr); other && other != game; other = GetWindow(other, GW_HWNDNEXT)) {
        if (!IsWindowVisible(other) || IsIconic(other) || isTaskbar(other)) continue;
        LONG style = GetWindowLongW(other, GWL_EXSTYLE);
        if (style & WS_EX_TRANSPARENT) continue;
        if (style & WS_EX_LAYERED) {
            BYTE alpha = 255; DWORD flags = 0;
            if (GetLayeredWindowAttributes(other, nullptr, &alpha, &flags) && (flags & LWA_ALPHA) && alpha < 16) continue;
        }
        BOOL cloaked = FALSE;
        if (SUCCEEDED(DwmGetWindowAttribute(other, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) continue;
        RECT rect{}, overlap{};
        if (FAILED(DwmGetWindowAttribute(other, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect))) && !GetWindowRect(other, &rect)) continue;
        if (IntersectRect(&overlap, &rect, &area)) return true;
    }
    return false;
}

static std::string captureDxgi(Device &device, HWND &cached, UINT maxWidth, UINT quality) {
    Clock clock;
    double cpuStart = cpuMs();
    HWND hwnd = gameWindow(cached);
    cached = hwnd;
    if (!hwnd) return failure("no-window", clock);
    if (IsIconic(hwnd)) return failure("minimised", clock);
    Timing timing;
    timing.find = clock.ms();
    RECT client{};
    POINT origin{0, 0};
    if (!GetClientRect(hwnd, &client) || !ClientToScreen(hwnd, &origin)) return failure("failed", clock);
    RECT area{origin.x, origin.y, origin.x + (client.right - client.left), origin.y + (client.bottom - client.top)};
    if (area.right <= area.left || area.bottom <= area.top) return failure("no-frame", clock);
    if (coveredByOther(hwnd, area)) return failure("covered", clock);

    // The output (monitor) the game is on, and the adapter that owns it: the duplication must be made on that adapter's device.
    HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    com_ptr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(factory.put())))) return failure("dxgi-unavailable", clock);
    com_ptr<IDXGIAdapter1> adapter;
    com_ptr<IDXGIOutput> output;
    DXGI_OUTPUT_DESC outputDesc{};
    for (UINT a = 0; !output; a++) {
        com_ptr<IDXGIAdapter1> candidate;
        if (factory->EnumAdapters1(a, candidate.put()) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT o = 0; ; o++) {
            com_ptr<IDXGIOutput> current;
            if (candidate->EnumOutputs(o, current.put()) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC desc{};
            if (SUCCEEDED(current->GetDesc(&desc)) && desc.Monitor == monitor) { adapter = candidate; output = current; outputDesc = desc; break; }
        }
    }
    if (!output) return failure("dxgi-unavailable", clock);
    // A game window that spans two monitors is not one picture of one output.
    const RECT &desktop = outputDesc.DesktopCoordinates;
    if (area.left < desktop.left || area.top < desktop.top || area.right > desktop.right || area.bottom > desktop.bottom) return failure("dxgi-unavailable", clock);

    // The device made for that adapter is kept between captures (making one is most of the work); the duplication itself is not.
    static com_ptr<ID3D11Device> keptDevice;
    static com_ptr<ID3D11DeviceContext> keptContext;
    static LUID keptAdapter{};
    DXGI_ADAPTER_DESC1 adapterDesc{};
    adapter->GetDesc1(&adapterDesc);
    if (!keptDevice || memcmp(&keptAdapter, &adapterDesc.AdapterLuid, sizeof(LUID)) != 0) {
        keptDevice = nullptr; keptContext = nullptr;
        if (FAILED(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, keptDevice.put(), nullptr, keptContext.put())))
            return failure("dxgi-unavailable", clock);
        keptAdapter = adapterDesc.AdapterLuid;
    }
    com_ptr<ID3D11Device> d3d = keptDevice;
    com_ptr<ID3D11DeviceContext> context = keptContext;
    com_ptr<IDXGIOutput1> output1 = output.try_as<IDXGIOutput1>();
    if (!output1) return failure("dxgi-unavailable", clock);
    com_ptr<IDXGIOutputDuplication> duplication;
    if (FAILED(output1->DuplicateOutput(d3d.get(), duplication.put()))) { keptDevice = nullptr; keptContext = nullptr; return failure("dxgi-unavailable", clock); }
    DXGI_OUTDUPL_DESC duplicationDesc{};
    duplication->GetDesc(&duplicationDesc);
    // A rotated monitor or an HDR (floating point) desktop is not handled: the border-showing capture is used instead.
    if (duplicationDesc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        || (duplicationDesc.Rotation != DXGI_MODE_ROTATION_IDENTITY && duplicationDesc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED))
        return failure("dxgi-unavailable", clock);

    // The first frame: a pointer-only update has no picture (LastPresentTime 0), so the wait goes on until the time is up.
    com_ptr<ID3D11Texture2D> staging;
    D3D11_TEXTURE2D_DESC desc{};
    for (int tries = 0; tries < 8 && !staging && clock.ms() - timing.find < FRAME_WAIT_MS + 400; tries++) {
        DXGI_OUTDUPL_FRAME_INFO info{};
        com_ptr<IDXGIResource> resource;
        HRESULT hr = duplication->AcquireNextFrame(FRAME_WAIT_MS, &info, resource.put());
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue;
        if (FAILED(hr)) return failure("dxgi-unavailable", clock);
        if (info.LastPresentTime.QuadPart != 0 || tries >= 2) {
            com_ptr<ID3D11Texture2D> texture = resource.try_as<ID3D11Texture2D>();
            if (texture) {
                texture->GetDesc(&desc);
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                desc.MiscFlags = 0;
                if (SUCCEEDED(d3d->CreateTexture2D(&desc, nullptr, staging.put()))) context->CopyResource(staging.get(), texture.get());
            }
        }
        duplication->ReleaseFrame();
    }
    timing.frame = clock.ms();
    duplication = nullptr;   // the duplication ends before any encoding, like the other method's session
    if (!staging) return failure("no-frame", clock);
    long x = area.left - desktop.left, y = area.top - desktop.top, w = area.right - area.left, h = area.bottom - area.top;
    if (x < 0 || y < 0 || x + w > (long)desc.Width || y + h > (long)desc.Height) return failure("dxgi-unavailable", clock);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return failure("failed", clock);
    timing.copy = clock.ms();
    Pixels pixels{static_cast<const BYTE *>(mapped.pData) + (size_t)y * mapped.RowPitch + (size_t)x * 4, mapped.RowPitch, (UINT)w, (UINT)h};
    std::vector<unsigned char> jpeg;
    UINT width = 0, height = 0;
    bool encoded = encodeJpeg(device, pixels, maxWidth, quality, jpeg, width, height);
    context->Unmap(staging.get(), 0);
    if (!encoded) return failure("failed", clock);
    return success(jpeg, width, height, (UINT)w, (UINT)h, timing, clock.ms(), cpuStart, "dxgi", false);
}

// ---- What this system can do about the capture border ----------------------------------------------------------------------
static unsigned windowsBuild() {
    typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto get = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    return get && get(&info) == 0 ? (unsigned)info.dwBuildNumber : 0;
}

// True only when Windows will leave the border out for this process: build 20348 or later (IsBorderRequired exists), and the app has a package identity
// that declares graphicsCaptureWithoutBorder and was granted borderless access (Microsoft's documentation of GraphicsCaptureSession.IsBorderRequired and
// GraphicsCaptureAccess.RequestAccessAsync). An unpackaged exe such as this one cannot declare the capability, so it does not ask (a request would only
// raise a prompt or fail): the answer is false and the bridge captures with Desktop Duplication instead.
static bool borderlessGranted() {
    try {
        if (g_build < 20348) return false;
        UINT32 length = 0;
        if (GetCurrentPackageFullName(&length, nullptr) == APPMODEL_ERROR_NO_PACKAGE) return false;
        if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsMethodPresent(L"Windows.Graphics.Capture.GraphicsCaptureAccess", L"RequestAccessAsync")) return false;
        auto status = wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
        return status == winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus::Allowed;
    } catch (...) { return false; }
}

// method: "dxgi" (no border), "wgc" (border unless borderless access was granted) or "auto" (borderless wgc, else dxgi, else wgc).
static std::string capture(Device &device, HWND &cached, UINT maxWidth, UINT quality, const char *method) {
    if (strcmp(method, "wgc") == 0) return captureWgc(device, cached, maxWidth, quality);
    if (strcmp(method, "dxgi") == 0) return captureDxgi(device, cached, maxWidth, quality);
    if (g_borderless || g_dxgiBroken) return captureWgc(device, cached, maxWidth, quality);
    std::string result = captureDxgi(device, cached, maxWidth, quality);
    // Only a system where this duplication cannot be made falls back to the capture that shows the border (and does not try again until the helper restarts);
    // a game that is covered or minimised just has no picture.
    if (result.find("\"reason\":\"dxgi-unavailable\"") == std::string::npos) return result;
    g_dxgiBroken = true;
    return captureWgc(device, cached, maxWidth, quality);
}

int wmain(int argc, wchar_t **argv) {
    init_apartment(apartment_type::multi_threaded);
    // Low priority: a capture must never compete with the game for the CPU.
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    // Development only: `--exe name.exe` captures that program's window instead of the game's (to check the picture without the game).
    for (int i = 1; i + 1 < argc; i++) if (wcscmp(argv[i], L"--exe") == 0) GAME_EXE = argv[i + 1];
    g_build = windowsBuild();
    try { g_wgcSupported = wgc::GraphicsCaptureSession::IsSupported(); } catch (...) { g_wgcSupported = false; }
    Device device;
    if (!createDevice(device)) { reply("{\"ok\":false,\"reason\":\"unsupported\"}"); return 2; }
    g_borderless = g_wgcSupported && borderlessGranted();
    // `borderless`: this system leaves the capture border out of Windows Graphics Capture; `dxgi`: Desktop Duplication can be asked for (the bridge tries it).
    reply(std::string("{\"ready\":true,\"build\":") + std::to_string(g_build) + ",\"wgc\":" + (g_wgcSupported ? "true" : "false")
        + ",\"borderless\":" + (g_borderless ? "true" : "false") + "}");
    HWND cached = nullptr;
    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        unsigned width = 0, quality = 0;
        char method[16] = "wgc";
        if (strncmp(line, "quit", 4) == 0) break;
        int parsed = sscanf_s(line, "capture %u %u %15s", &width, &quality, method, (unsigned)sizeof(method));
        if (parsed >= 2 && width >= 64 && width <= 2048 && quality >= 1 && quality <= 100
            && (strcmp(method, "wgc") == 0 || strcmp(method, "dxgi") == 0 || strcmp(method, "auto") == 0)) {
            std::string result;
            try { result = capture(device, cached, width, quality, method); }
            catch (...) { result = "{\"ok\":false,\"reason\":\"failed\"}"; }
            reply(result);
        } else reply("{\"ok\":false,\"reason\":\"bad-request\"}");
    }
    return 0;
}
