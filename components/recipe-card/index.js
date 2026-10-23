Component({
  properties: {recipe: Object},
  methods: {open() { this.triggerEvent('open', {id: this.data.recipe.id}); }}
});
