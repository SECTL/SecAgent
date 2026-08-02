(() => {
  const assets = new Set(["/icon.svg", "/icon.png", "/session-chevron.svg", "/image-icon.svg", "/mic-icon.svg"]);
  const normalize = (value) => typeof value === "string" && assets.has(value) ? `.${value}` : value;
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, name === "src" ? normalize(value) : value);
  };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (descriptor?.set) Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value) { descriptor.set.call(this, normalize(value)); } });
})();
