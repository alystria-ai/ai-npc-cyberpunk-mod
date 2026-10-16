/*
 * AI NPC Cyberpunk Mod vision helper: takes one still picture of the Cyberpunk 2077 window, on request, for
 * "Companions can see" (docs/COMPANION_VISION.md).
 *
 * Out of process and on demand. The game is never touched: no injection, no hook, no game-thread work. A capture
 * opens a Windows Graphics Capture session on the game's own window (never a monitor, so other windows and the
 * desktop can never appear), takes the first frame, closes the session at once, scales it down and encodes a JPEG
 * in memory. Nothing is written to disk.
 *
 * Protocol: one request per stdin line, one JSON reply per stdout line, in order.
 *   capture <maxWidth 64..2048> <quality 1..100>
 *     -> {"ok":true,"width":W,"height":H,"sourceWidth":SW,"sourceHeight":SH,"bytes":N,
 *         "ms":{"find":..,"frame":..,"copy":..,"encode":..,"total":..,"cpu":..},"jpeg":"<base64>"}
 *     -> {"ok":false,"reason":"no-window|minimised|unsupported|no-frame|failed","ms":{"total":..}}
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
#include <dxgi.h>
#include <dwmapi.h>
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

static const wchar_t *GAME_EXE = L"Cyberpunk2077.exe";
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

// One still picture of the game window, or a failure reason. The capture session lives only until the first frame.
static std::string capture(Device &device, HWND &cached, UINT maxWidth, UINT quality) {
    Clock clock;
    double cpuStart = cpuMs();
    HWND hwnd = gameWindow(cached);
    cached = hwnd;
    if (!hwnd) return failure("no-window", clock);
    if (IsIconic(hwnd)) return failure("minimised", clock);
    double findMs = clock.ms();

    auto interop = get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    wgc::GraphicsCaptureItem item{nullptr};
    if (FAILED(interop->CreateForWindow(hwnd, guid_of<wgc::GraphicsCaptureItem>(), put_abi(item))) || !item)
        return failure("failed", clock);
    auto size = item.Size();
    if (size.Width <= 0 || size.Height <= 0) return failure("no-frame", clock);

    auto pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(device.winrt,
        wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size);
    auto session = pool.CreateCaptureSession(item);
    // Never draw the cursor; never draw the yellow capture border around the game (Windows 11).
    try { session.IsCursorCaptureEnabled(false); } catch (...) {}
    try { session.IsBorderRequired(false); } catch (...) {}
    HANDLE arrived = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    auto token = pool.FrameArrived([arrived](auto &&, auto &&) { SetEvent(arrived); });
    session.StartCapture();
    DWORD waited = WaitForSingleObject(arrived, FRAME_WAIT_MS);
    wgc::Direct3D11CaptureFrame frame{nullptr};
    if (waited == WAIT_OBJECT_0) frame = pool.TryGetNextFrame();
    double frameMs = clock.ms();

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
    double copyMs = clock.ms();
    BYTE *pixels = static_cast<BYTE *>(mapped.pData) + (size_t)cropY * mapped.RowPitch + (size_t)cropX * 4;
    UINT width = std::min(maxWidth, sourceWidth);
    UINT height = std::max<UINT>(1, (UINT)((double)sourceHeight * width / sourceWidth + 0.5));
    std::vector<unsigned char> jpeg;
    bool encoded = false;
    {
        com_ptr<IWICBitmap> bitmap;
        com_ptr<IWICBitmapScaler> scaler;
        com_ptr<IStream> stream;
        com_ptr<IWICBitmapEncoder> encoder;
        com_ptr<IWICBitmapFrameEncode> target;
        com_ptr<IPropertyBag2> options;
        // The game draws opaque pixels; BGRX keeps a stray alpha channel out of the picture.
        if (SUCCEEDED(device.wic->CreateBitmapFromMemory(sourceWidth, sourceHeight, GUID_WICPixelFormat32bppBGR,
                mapped.RowPitch, mapped.RowPitch * (sourceHeight - 1) + sourceWidth * 4, pixels, bitmap.put()))
            && SUCCEEDED(device.wic->CreateBitmapScaler(scaler.put()))
            && SUCCEEDED(scaler->Initialize(bitmap.get(), width, height, WICBitmapInterpolationModeFant))
            && SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()))
            && SUCCEEDED(device.wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put()))
            && SUCCEEDED(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache))
            && SUCCEEDED(encoder->CreateNewFrame(target.put(), options.put()))) {
            PROPBAG2 option{};
            wchar_t name[] = L"ImageQuality";
            option.pstrName = name;
            VARIANT value;
            VariantInit(&value);
            value.vt = VT_R4;
            value.fltVal = quality / 100.0f;
            options->Write(1, &option, &value);
            WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
            if (SUCCEEDED(target->Initialize(options.get())) && SUCCEEDED(target->SetSize(width, height))
                && SUCCEEDED(target->SetPixelFormat(&format)) && SUCCEEDED(target->WriteSource(scaler.get(), nullptr))
                && SUCCEEDED(target->Commit()) && SUCCEEDED(encoder->Commit())) {
                HGLOBAL global = nullptr;
                if (SUCCEEDED(GetHGlobalFromStream(stream.get(), &global))) {
                    STATSTG stat{};
                    stream->Stat(&stat, STATFLAG_NONAME);
                    const unsigned char *bytes = static_cast<const unsigned char *>(GlobalLock(global));
                    if (bytes) {
                        jpeg.assign(bytes, bytes + (size_t)stat.cbSize.QuadPart);
                        GlobalUnlock(global);
                        encoded = !jpeg.empty();
                    }
                }
            }
        }
    }
    device.context->Unmap(staging.get(), 0);
    if (!encoded) return failure("failed", clock);
    double encodeMs = clock.ms();
    return "{\"ok\":true,\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height)
        + ",\"sourceWidth\":" + std::to_string(sourceWidth) + ",\"sourceHeight\":" + std::to_string(sourceHeight)
        + ",\"bytes\":" + std::to_string(jpeg.size())
        + ",\"ms\":{\"find\":" + number(findMs) + ",\"frame\":" + number(frameMs - findMs)
        + ",\"copy\":" + number(copyMs - frameMs) + ",\"encode\":" + number(encodeMs - copyMs)
        + ",\"total\":" + number(encodeMs) + ",\"cpu\":" + number(cpuMs() - cpuStart) + "},\"jpeg\":\"" + base64(jpeg.data(), jpeg.size()) + "\"}";
}

int wmain() {
    init_apartment(apartment_type::multi_threaded);
    // Low priority: a capture must never compete with the game for the CPU.
    SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    if (!wgc::GraphicsCaptureSession::IsSupported()) { reply("{\"ok\":false,\"reason\":\"unsupported\"}"); return 2; }
    Device device;
    if (!createDevice(device)) { reply("{\"ok\":false,\"reason\":\"unsupported\"}"); return 2; }
    reply("{\"ready\":true}");
    HWND cached = nullptr;
    char line[256];
    while (fgets(line, sizeof(line), stdin)) {
        unsigned width = 0, quality = 0;
        if (strncmp(line, "quit", 4) == 0) break;
        if (sscanf_s(line, "capture %u %u", &width, &quality) == 2 && width >= 64 && width <= 2048
            && quality >= 1 && quality <= 100) {
            std::string result;
            try { result = capture(device, cached, width, quality); }
            catch (...) { result = "{\"ok\":false,\"reason\":\"failed\"}"; }
            reply(result);
        } else reply("{\"ok\":false,\"reason\":\"bad-request\"}");
    }
    return 0;
}
