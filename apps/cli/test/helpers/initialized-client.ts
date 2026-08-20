export const initializedInitApi = {
  init: {
    status: {
      get: async () => ({ data: { initialized: true }, status: 200 })
    }
  }
};
