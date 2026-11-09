import sys
import os
import io
import time
import base64
import tempfile
import ctypes
from ctypes import wintypes

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# ============================================================================
# MOTOR 1: OPENCV (SE INSTALADO)
# ============================================================================

def open_camera_cv2(camera_index=0):
    backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]
    indices = [camera_index, 1 if camera_index == 0 else 0]

    for idx in indices:
        for backend in backends:
            try:
                cap = cv2.VideoCapture(idx, backend)
                if cap is not None and cap.isOpened():
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                    ret, frame = cap.read()
                    if ret and frame is not None:
                        return cap
                    cap.release()
            except Exception:
                pass
    return None


def encode_frame_cv2_b64(frame, quality=80):
    ok, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return None
    b64 = base64.b64encode(buffer).decode('utf-8')
    return f"data:image/jpeg;base64,{b64}"


def capture_single_cv2(camera_index=0):
    cap = open_camera_cv2(camera_index)
    if cap is None:
        return None

    ret, frame = False, None
    for _ in range(3):
        ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        return None
    return encode_frame_cv2_b64(frame, quality=85)


def stream_frames_cv2(camera_index=0, fps=12):
    cap = open_camera_cv2(camera_index)
    if cap is None:
        return False

    interval = 1.0 / max(1, fps)
    try:
        while True:
            t0 = time.time()
            ret, frame = cap.read()
            if not ret or frame is None:
                time.sleep(0.1)
                continue

            encoded = encode_frame_cv2_b64(frame, quality=75)
            if encoded:
                sys.stdout.write(encoded + "\n")
                sys.stdout.flush()

            elapsed = time.time() - t0
            if elapsed < interval:
                time.sleep(interval - elapsed)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        cap.release()
    return True


# ============================================================================
# MOTOR 2: API NATIVA DO WINDOWS (AVICAP32.DLL + PILLOW)
# Não exige download externo (opencv) e acessa webcams USB direto pelo Windows
# ============================================================================

WM_USER = 0x0400
WM_CAP_DRIVER_CONNECT = WM_USER + 10
WM_CAP_DRIVER_DISCONNECT = WM_USER + 11
WM_CAP_FILE_SAVEDIBW = WM_USER + 25
WM_CAP_GRAB_FRAME = WM_USER + 60


class WinAviCamera:
    def __init__(self, camera_index=0):
        self.camera_index = camera_index
        self.hwnd = None
        self.user32 = ctypes.windll.user32
        self.avicap32 = ctypes.windll.avicap32

        self.avicap32.capCreateCaptureWindowW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, ctypes.c_int
        ]
        self.avicap32.capCreateCaptureWindowW.restype = wintypes.HWND

        self.user32.SendMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
        ]
        self.user32.SendMessageW.restype = wintypes.LPARAM

    def open(self):
        self.hwnd = self.avicap32.capCreateCaptureWindowW(
            "BipouCam", 0, 0, 0, 640, 480, 0, 0
        )
        if not self.hwnd:
            return False

        indices = [self.camera_index, 1 if self.camera_index == 0 else 0]
        for idx in indices:
            connected = self.user32.SendMessageW(self.hwnd, WM_CAP_DRIVER_CONNECT, idx, 0)
            if connected:
                return True

        self.user32.DestroyWindow(self.hwnd)
        self.hwnd = None
        return False

    def grab_b64(self, tmp_bmp_path, quality=80):
        if not self.hwnd or not HAS_PIL:
            return None

        grabbed = self.user32.SendMessageW(self.hwnd, WM_CAP_GRAB_FRAME, 0, 0)
        if not grabbed:
            return None

        bmp_ptr = ctypes.cast(ctypes.create_unicode_buffer(tmp_bmp_path), wintypes.LPARAM)
        saved = self.user32.SendMessageW(self.hwnd, WM_CAP_FILE_SAVEDIBW, 0, bmp_ptr)
        if not saved or not os.path.exists(tmp_bmp_path):
            return None

        with Image.open(tmp_bmp_path) as img:
            rgb = img.convert('RGB')
            buf = io.BytesIO()
            rgb.save(buf, format='JPEG', quality=quality)
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
            return f"data:image/jpeg;base64,{b64}"

    def close(self):
        if self.hwnd:
            try:
                self.user32.SendMessageW(self.hwnd, WM_CAP_DRIVER_DISCONNECT, 0, 0)
                self.user32.DestroyWindow(self.hwnd)
            except Exception:
                pass
            self.hwnd = None


def capture_single_avicap(camera_index=0):
    cam = WinAviCamera(camera_index)
    if not cam.open():
        return None

    tmp_bmp = os.path.join(tempfile.gettempdir(), f"bipa_cam_{os.getpid()}.bmp")
    try:
        # Descarta 2 quadros iniciais para ajuste de brilho
        for _ in range(2):
            cam.user32.SendMessageW(cam.hwnd, WM_CAP_GRAB_FRAME, 0, 0)
            time.sleep(0.05)
        return cam.grab_b64(tmp_bmp, quality=85)
    finally:
        cam.close()
        if os.path.exists(tmp_bmp):
            try:
                os.remove(tmp_bmp)
            except Exception:
                pass


def stream_frames_avicap(camera_index=0, fps=10):
    cam = WinAviCamera(camera_index)
    if not cam.open():
        return False

    tmp_bmp = os.path.join(tempfile.gettempdir(), f"bipa_stream_{os.getpid()}.bmp")
    interval = 1.0 / max(1, fps)
    try:
        while True:
            t0 = time.time()
            encoded = cam.grab_b64(tmp_bmp, quality=75)
            if encoded:
                sys.stdout.write(encoded + "\n")
                sys.stdout.flush()

            elapsed = time.time() - t0
            if elapsed < interval:
                time.sleep(interval - elapsed)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        cam.close()
        if os.path.exists(tmp_bmp):
            try:
                os.remove(tmp_bmp)
            except Exception:
                pass
    return True


if __name__ == '__main__':
    cam_idx = int(os.environ.get('WEBCAM_INDEX', 0))
    stream_mode = '--stream' in sys.argv

    for arg in sys.argv[1:]:
        if arg != '--stream':
            try:
                cam_idx = int(arg)
            except ValueError:
                pass

    try:
        if stream_mode:
            ok = False
            if HAS_CV2:
                ok = stream_frames_cv2(cam_idx)
            if not ok and os.name == 'nt':
                ok = stream_frames_avicap(cam_idx)
            if not ok:
                sys.stderr.write("Erro: Não foi possível abrir a câmera da lixeira para transmissão.\n")
                sys.exit(1)
        else:
            res = None
            if HAS_CV2:
                res = capture_single_cv2(cam_idx)
            if not res and os.name == 'nt':
                res = capture_single_avicap(cam_idx)
            if not res:
                sys.stderr.write("Erro: Não foi possível capturar imagem da câmera conectada à lixeira.\n")
                sys.exit(1)
            print(res)
    except Exception as e:
        sys.stderr.write(f"Erro ao capturar câmera: {str(e)}\n")
        sys.exit(1)
