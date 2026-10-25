package io.github.pipo3355.anixartoffline;

import android.app.PictureInPictureParams;
import android.os.Build;
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

    @PluginMethod
    public void isPip(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("active", pipActive);
        call.resolve(ret);
    }
}
