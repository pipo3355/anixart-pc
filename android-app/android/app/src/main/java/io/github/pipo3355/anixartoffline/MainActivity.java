package io.github.pipo3355.anixartoffline;

import android.content.res.Configuration;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // свой плагин нужно зарегистрировать до запуска моста
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        PluginHandle handle = getBridge().getPlugin("Device");
        if (handle != null && handle.getInstance() instanceof DevicePlugin) {
            ((DevicePlugin) handle.getInstance()).onPipChanged(isInPictureInPictureMode);
        }
    }
}
