package io.github.pipo3355.anixartoffline;

import android.app.PictureInPictureParams;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;
import android.os.StatFs;
import android.util.Rational;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Маленький плагин для того, чего нет в стандартных плагинах Capacitor:
 * свободное место на телефоне и режим «картинка в картинке».
 */
@CapacitorPlugin(name = "Device")
public class DevicePlugin extends Plugin {

    private boolean pipActive = false;
    private final ResumableDownloader downloader = new ResumableDownloader();

    /**
     * Скачать файл с докачкой (см. ResumableDownloader). Прогресс — событие «downloadProgress»
     * {id, bytes, total}. Ошибки: code CANCELED (отменили), HTTP (сервер отказал), NETWORK (сеть).
     */
    @PluginMethod
    public void downloadFile(PluginCall call) {
        final String id = call.getString("id");
        String url = call.getString("url");
        String path = call.getString("path");
        if (id == null || url == null || path == null) { call.reject("Не хватает параметров"); return; }
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        JSObject h = call.getObject("headers", new JSObject());
        java.util.Iterator<String> keys = h.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            headers.put(k, h.getString(k));
        }
        Double expect = call.getDouble("expectTotal", 0.0);
        long expectTotal = expect == null ? 0 : expect.longValue();
        downloader.start(id, url, path, headers, expectTotal,
                (bytes, total) -> {
                    JSObject p = new JSObject();
                    p.put("id", id);
                    p.put("bytes", bytes);
                    p.put("total", total);
                    notifyListeners("downloadProgress", p);
                },
                new ResumableDownloader.Done() {
                    @Override public void ok(long size, long total) {
                        JSObject r = new JSObject();
                        r.put("size", size);
                        r.put("total", total);
                        call.resolve(r);
                    }
                    @Override public void fail(Exception e) {
                        String code = e instanceof ResumableDownloader.Canceled ? "CANCELED"
                                : e instanceof ResumableDownloader.HttpError ? "HTTP" : "NETWORK";
                        call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), code);
                    }
                });
    }

    private final android.os.Handler timers = new android.os.Handler(android.os.Looper.getMainLooper());

    /**
     * Таймер на стороне Android. Таймеры JS (setTimeout) в свёрнутом приложении замирают,
     * а ответ плагина доходит до JS всегда — им загрузки и пользуются в фоне.
     */
    @PluginMethod
    public void sleep(PluginCall call) {
        int ms = Math.max(0, call.getInt("ms", 0));
        timers.postDelayed(call::resolve, ms);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = call.getString("id");
        if (id != null) downloader.cancel(id);
        call.resolve();
    }

    /** Свободное и общее место в хранилище приложения, в байтах. */
    @PluginMethod
    public void storage(PluginCall call) {
        File dir = getContext().getFilesDir();
        StatFs stat = new StatFs(dir.getAbsolutePath());
        JSObject ret = new JSObject();
        ret.put("free", stat.getAvailableBytes());
        ret.put("total", stat.getTotalBytes());
        call.resolve(ret);
    }

    /** Свернуть приложение в маленькое окно поверх других (Android 8+). */
    @PluginMethod
    public void enterPip(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("Картинка в картинке доступна с Android 8");
            return;
        }
        int w = call.getInt("width", 16);
        int h = call.getInt("height", 9);
        // Android принимает соотношение сторон только в пределах от 1:2.39 до 2.39:1
        double ratio = Math.max(1 / 2.39, Math.min(2.39, (double) w / h));
        Rational aspect = new Rational((int) Math.round(ratio * 1000), 1000);
        getActivity().runOnUiThread(() -> {
            try {
                PictureInPictureParams params = new PictureInPictureParams.Builder().setAspectRatio(aspect).build();
                boolean ok = getActivity().enterPictureInPictureMode(params);
                if (ok) call.resolve();
                else call.reject("Система не разрешила картинку в картинке");
            } catch (Exception e) {
                call.reject("Картинка в картинке недоступна: " + e.getMessage());
            }
        });
    }

    /** Вызывается из MainActivity, когда окно входит в «картинку в картинке» или выходит из неё. */
    public void onPipChanged(boolean active) {
        pipActive = active;
        JSObject data = new JSObject();
        data.put("active", active);
        notifyListeners("pipChanged", data);
    }

    /** Можно ли этому приложению ставить APK (Android 8+ спрашивает отдельно). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(ret);
    }

    /** Открыть системный экран «Разрешить установку из этого источника» для нашего приложения. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    /**
     * Запустить установку скачанного APK. path — путь файла внутри кэша приложения
     * (как его отдаёт Filesystem.getUri в Directory.Cache, «file://…» или без схемы).
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("Не указан файл"); return; }
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        File file = new File(path);
        if (!file.exists()) { call.reject("Файл обновления не найден"); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("Нужно разрешить установку из этого приложения", "NEED_PERMISSION");
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось открыть установщик: " + e.getMessage());
        }
    }

    /** Идут загрузки: держать приложение живым в фоне и показать прогресс в уведомлении. */
    @PluginMethod
    public void downloadsActive(PluginCall call) {
        String text = call.getString("text", "Идёт загрузка серий");
        int progress = call.getInt("progress", -1);
        try {
            DownloadService.update(getContext(), text, progress);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось запустить фоновую загрузку: " + e.getMessage());
        }
    }

    /** Загрузок больше нет — убрать уведомление и отпустить приложение. */
    @PluginMethod
    public void downloadsIdle(PluginCall call) {
        DownloadService.stop(getContext());
        call.resolve();
    }

    /** Android 13+: попросить разрешение на уведомления (иначе прогресс загрузки не виден). */
    @PluginMethod
    public void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
                && androidx.core.content.ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(),
                    new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 7302);
        }
        call.resolve();
    }

    @PluginMethod
    public void isPip(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("active", pipActive);
        call.resolve(ret);
    }
}
