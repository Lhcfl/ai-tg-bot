export const v = {
  boolean: (defaultValue: boolean) => (x: string | undefined) => {
    if (x === undefined) {
      return defaultValue;
    }
    return x.toLowerCase() === "true";
  },
};
