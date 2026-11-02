Component({
  properties: {
    visible: {type: Boolean, value: false},
    message: {type: String, value: ''},
    busy: {type: Boolean, value: false},
    error: {type: String, value: ''}
  },
  methods: {
    share() { if (!this.properties.busy) this.triggerEvent('share'); },
    keep() { if (!this.properties.busy) this.triggerEvent('keep'); }
  }
});
