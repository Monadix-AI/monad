#define COBJMACROS
#define INITGUID

#include <windows.h>
#include <initguid.h>
#include <propkey.h>
#include <shobjidl.h>
#include <stdio.h>
#include <wchar.h>

static const wchar_t *MONAD_TOAST_ACTIVATOR_CLSID = L"{AE4B7C58-7765-4BF4-B0D9-EB5550EAC5AB}";

static void print_hresult(const wchar_t *operation, HRESULT result) {
  fwprintf(stderr, L"%ls failed (0x%08lx)\n", operation, (unsigned long)result);
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 3) {
    fwprintf(stderr, L"usage: monad-shortcut-aumid.exe <shortcut.lnk> <app-user-model-id>\n");
    return 2;
  }

  HRESULT result = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  if (FAILED(result)) {
    print_hresult(L"CoInitializeEx", result);
    return 1;
  }

  IShellLinkW *link = NULL;
  IPersistFile *persist = NULL;
  IPropertyStore *properties = NULL;
  PROPVARIANT value;
  PROPVARIANT toast_activator;
  PropVariantInit(&value);
  PropVariantInit(&toast_activator);
  int exit_code = 1;

  result = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, &IID_IShellLinkW, (void **)&link);
  if (FAILED(result)) {
    print_hresult(L"CoCreateInstance", result);
    goto cleanup;
  }

  result = IShellLinkW_QueryInterface(link, &IID_IPersistFile, (void **)&persist);
  if (FAILED(result)) {
    print_hresult(L"QueryInterface(IPersistFile)", result);
    goto cleanup;
  }
  result = IPersistFile_Load(persist, argv[1], STGM_READWRITE);
  if (FAILED(result)) {
    print_hresult(L"IPersistFile::Load", result);
    goto cleanup;
  }

  result = IShellLinkW_QueryInterface(link, &IID_IPropertyStore, (void **)&properties);
  if (FAILED(result)) {
    print_hresult(L"QueryInterface(IPropertyStore)", result);
    goto cleanup;
  }
  size_t value_bytes = (wcslen(argv[2]) + 1) * sizeof(wchar_t);
  value.vt = VT_LPWSTR;
  value.pwszVal = (wchar_t *)CoTaskMemAlloc(value_bytes);
  if (!value.pwszVal) {
    print_hresult(L"CoTaskMemAlloc", E_OUTOFMEMORY);
    goto cleanup;
  }
  CopyMemory(value.pwszVal, argv[2], value_bytes);
  result = IPropertyStore_SetValue(properties, &PKEY_AppUserModel_ID, &value);
  if (FAILED(result)) {
    print_hresult(L"IPropertyStore::SetValue", result);
    goto cleanup;
  }
  toast_activator.vt = VT_CLSID;
  toast_activator.puuid = (CLSID *)CoTaskMemAlloc(sizeof(CLSID));
  if (!toast_activator.puuid) {
    print_hresult(L"CoTaskMemAlloc", E_OUTOFMEMORY);
    goto cleanup;
  }
  result = CLSIDFromString(MONAD_TOAST_ACTIVATOR_CLSID, toast_activator.puuid);
  if (FAILED(result)) {
    print_hresult(L"CLSIDFromString", result);
    goto cleanup;
  }
  result = IPropertyStore_SetValue(properties, &PKEY_AppUserModel_ToastActivatorCLSID, &toast_activator);
  if (FAILED(result)) {
    print_hresult(L"IPropertyStore::SetValue(ToastActivatorCLSID)", result);
    goto cleanup;
  }
  result = IPropertyStore_Commit(properties);
  if (FAILED(result)) {
    print_hresult(L"IPropertyStore::Commit", result);
    goto cleanup;
  }
  result = IPersistFile_Save(persist, argv[1], TRUE);
  if (FAILED(result)) {
    print_hresult(L"IPersistFile::Save", result);
    goto cleanup;
  }

  exit_code = 0;

cleanup:
  PropVariantClear(&toast_activator);
  PropVariantClear(&value);
  if (properties) IPropertyStore_Release(properties);
  if (persist) IPersistFile_Release(persist);
  if (link) IShellLinkW_Release(link);
  CoUninitialize();
  return exit_code;
}
